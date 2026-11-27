/**
 * Acceptance & Integration Test Suite for Krix Learning Mechanism.
 *
 * Covers all 12 required scenarios:
 *  Test 1:  New Knowledge Acquisition
 *  Test 2:  Existing Knowledge Integration (no duplicate concepts)
 *  Test 3:  Contradictory Information (provenance preserved, conflict flagged)
 *  Test 4:  Learning Persistence (survives restart via file-backed StorageAdapter)
 *  Test 5:  Actual Agent Core Application (end-to-end: teach -> validate -> persist -> restart -> AgentCore retrieves & applies)
 *  Test 6:  Mistake Correction (error analysis -> correction -> later retrieval)
 *  Test 7:  Skill Acquisition (evidence gate: cannot become verified without practical evidence)
 *  Test 8:  Learning-to-Learn (tracks strategy outcomes & flags difficult concepts)
 *  Test 9:  Duplicate Prevention (idempotent repeated intake)
 *  Test 10: Resource Limits (bounded queue, concurrency, cancellation)
 *  Test 11: Academy Contract (submitLesson, guided session, practice, assessment, gap explanation, query)
 *  Test 12: Regression check on LearningMechanism + ContextFormatter
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentCore } from '../src/agent/agentCore';
import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { MemoryStorage, TaskStore } from '../src/agent/taskState';
import {
  LearningOrchestrator,
  createFileStorageAdapter,
  formatLearningContext,
} from '../src/agent/learning';

let passed = 0;
let failed = 0;

function assert(condition: unknown, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

async function run() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'krix-learn-test-'));

  try {
    // ---------------------------------------------------------------- Test 1
    console.log('\nTest 1 — New Knowledge Acquisition');
    {
      const orch = new LearningOrchestrator({ storage: new MemoryStorage() });
      const out = orch.learnFromText(
        'Python is a high-level interpreted programming language known for readability.',
        'conversation',
        's1'
      );
      assert(out.conceptsAcquired.length === 1, 'acquired 1 new concept');
      const retrieved = orch.retrieveRelevantKnowledge('Python programming language');
      assert(retrieved.length >= 1, 'retrieved Python concept');
      assert(
        retrieved[0].label.toLowerCase() === 'python',
        `concept label is Python (got "${retrieved[0]?.label}")`
      );
      assert(retrieved[0].confidence >= 0.6, 'confidence >= 0.6');
    }

    // ---------------------------------------------------------------- Test 2
    console.log('\nTest 2 — Existing Knowledge Integration');
    {
      const orch = new LearningOrchestrator({ storage: new MemoryStorage() });
      const out1 = orch.learnFromText(
        'TypeScript is a strongly typed programming language that builds on JavaScript.',
        'conversation',
        's2a'
      );
      const out2 = orch.learnFromText(
        'TypeScript is used to catch type errors at compile time before running code.',
        'conversation',
        's2b'
      );
      assert(out1.conceptsAcquired.length === 1, 'first pass creates TypeScript concept');
      assert(
        out2.conceptsAcquired.length === 0 && out2.conceptsUpdated.length === 1,
        'second pass integrates into existing concept instead of duplicating'
      );
      const allTs = orch.store
        .getAllConcepts()
        .filter((c) => c.label.toLowerCase() === 'typescript');
      assert(allTs.length === 1, 'only 1 TypeScript concept exists in store');
      assert(allTs[0].version >= 2, 'concept version incremented');
      assert(allTs[0].provenance.length === 2, 'provenance preserved from both sources');
    }

    // ---------------------------------------------------------------- Test 3
    console.log('\nTest 3 — Contradictory Information');
    {
      const orch = new LearningOrchestrator({ storage: new MemoryStorage() });
      orch.learnFromText(
        'Python is a high-level interpreted programming language.',
        'conversation',
        's3a'
      );
      const conflictOut = orch.learnFromText(
        'Python is a low-level compiled hardware language.',
        'research',
        's3b'
      );
      assert(conflictOut.conflicts.length === 1, 'contradiction detected and flagged');
      const concept = orch.store.findConceptByLabel('Python');
      assert(!!concept, 'original Python concept preserved');
      assert(
        concept!.definition.includes('high-level'),
        'original definition NOT silently overwritten'
      );
      assert(
        concept!.contradictions.length === 1 && !concept!.contradictions[0].resolved,
        'unresolved contradiction attached to concept'
      );
    }

    // ---------------------------------------------------------------- Test 4
    console.log('\nTest 4 — Learning Persistence Across Restart');
    {
      const dir4 = path.join(tempRoot, 't4');
      const orch1 = new LearningOrchestrator({
        storage: createFileStorageAdapter(dir4),
      });
      orch1.learnFromText(
        'Docker is a containerization platform for packaging applications.',
        'academy',
        's4'
      );

      // Simulate full process restart: brand new orchestrator reading from disk
      const orch2 = new LearningOrchestrator({
        storage: createFileStorageAdapter(dir4),
      });
      const recalled = orch2.retrieveRelevantKnowledge('Docker containerization');
      assert(recalled.length === 1, 'Docker concept survived restart');
      assert(
        recalled[0].definition.includes('containerization'),
        'persisted definition intact'
      );
    }

    // ---------------------------------------------------------------- Test 5
    console.log('\nTest 5 — Actual Agent Core Application (End-to-End)');
    {
      const dir5 = path.join(tempRoot, 't5');
      // 1. Teach Krix something new & validate via Academy
      const teacherOrch = new LearningOrchestrator({
        storage: createFileStorageAdapter(dir5),
      });
      const academy = teacherOrch.getAcademyService();
      const lessonOut = await academy.submitLesson({
        topic: 'KrixProtocol',
        content:
          'KrixProtocol is a local binary framing format using header byte 0xA7.',
      });
      assert(lessonOut.conceptsAcquired.length === 1, 'taught KrixProtocol via Academy');
      await academy.submitAssessmentResult('s5_assess', {
        sessionId: 's5_assess',
        conceptIds: lessonOut.conceptsAcquired,
        passed: true,
        score: 1.0,
        weakAreas: [],
      });

      // 2. Simulate full restart: new orchestrator + new AgentCore
      const restartedOrch = new LearningOrchestrator({
        storage: createFileStorageAdapter(dir5),
      });
      const bus = new AgentEventBus();
      const registry = new ToolRegistry(bus);
      let observedLearnedContext: string | undefined;

      registry.register({
        name: 'system.note',
        description: 'Record a note',
        category: 'system',
        capabilities: ['system.note'],
        riskLevel: 'low',
        execute: async (_input, ctx) => {
          observedLearnedContext = ctx.learnedContext;
          return {
            success: true,
            output: { noted: true, usedLearnedContext: Boolean(ctx.learnedContext) },
          };
        },
      });

      const core = new AgentCore({
        registry,
        events: bus,
        store: new TaskStore(new MemoryStorage()),
        learningProvider: (input) => restartedOrch.buildReasoningContext(input),
      });

      const task = await core.submit('Check what header byte KrixProtocol uses');
      assert(task.status === 'completed', 'AgentCore task completed');
      assert(
        Boolean(task.learnedContext && task.learnedContext.includes('0xA7')),
        'AgentCore attached learned KrixProtocol knowledge to task.learnedContext'
      );
      assert(
        Boolean(observedLearnedContext && observedLearnedContext.includes('KrixProtocol')),
        'Tool execution received learnedContext inside ToolContext'
      );
    }

    // ---------------------------------------------------------------- Test 6
    console.log('\nTest 6 — Mistake Correction');
    {
      const orch = new LearningOrchestrator({ storage: new MemoryStorage() });
      const corr = orch.processCorrection(
        'Python uses curly braces for code blocks',
        'Python uses indentation for code blocks',
        'python syntax'
      );
      assert(Boolean(corr.id), 'correction record created');
      const dup = orch.processCorrection(
        'Python uses curly braces for code blocks',
        'Python uses indentation for code blocks',
        'python syntax'
      );
      assert(dup.id === corr.id, 'near-identical correction deduplicated');
      const found = orch.retrieveCorrections('Python block syntax curly braces');
      assert(
        found.some((c) => c.correctedKnowledge.includes('indentation')),
        'correction retrieved in later relevant context'
      );
    }

    // ---------------------------------------------------------------- Test 7
    console.log('\nTest 7 — Skill Acquisition Evidence Gate');
    {
      const orch = new LearningOrchestrator({ storage: new MemoryStorage() });
      const out = orch.learnFromText(
        'SQLite is an embedded relational database engine.',
        'academy',
        's7'
      );
      const skill = orch.skillAcquisition.proposeSkill(
        'SQLite Querying',
        'Run parameterized SQLite queries safely',
        'Use prepared statements with bound parameters',
        out.conceptsAcquired,
        orch.store
      );
      assert(skill.masteryStatus === 'unverified', 'new skill starts unverified');

      // 1 practical pass is not enough
      const after1 = orch.skillAcquisition.addValidationEvidence(
        skill.id,
        {
          type: 'task_success',
          description: 'Query 1 passed',
          timestamp: Date.now(),
          passed: true,
        },
        orch.store
      );
      assert(after1!.masteryStatus === 'unverified', '1 evidence keeps skill unverified');

      // 2nd practical pass -> 'tested'
      const after2 = orch.skillAcquisition.addValidationEvidence(
        skill.id,
        {
          type: 'test_pass',
          description: 'Query 2 passed',
          timestamp: Date.now(),
          passed: true,
        },
        orch.store
      );
      assert(after2!.masteryStatus === 'tested', '2 practical evidences promote to tested');

      // Cannot become 'expert' without user_confirmation even with 4 practical passes
      orch.skillAcquisition.addValidationEvidence(
        skill.id,
        { type: 'task_success', description: 'Q3', timestamp: Date.now(), passed: true },
        orch.store
      );
      const after4 = orch.skillAcquisition.addValidationEvidence(
        skill.id,
        { type: 'test_pass', description: 'Q4', timestamp: Date.now(), passed: true },
        orch.store
      );
      assert(
        after4!.masteryStatus === 'proficient',
        '4 diverse practical evidences promote to proficient (not expert)'
      );
    }

    // ---------------------------------------------------------------- Test 8
    console.log('\nTest 8 — Learning-to-Learn');
    {
      const orch = new LearningOrchestrator({ storage: new MemoryStorage() });
      orch.learningToLearn.trackAttempt('guided_examples', 'academy', true, 'c1', orch.store);
      orch.learningToLearn.trackAttempt('guided_examples', 'academy', true, 'c2', orch.store);
      orch.learningToLearn.trackAttempt('guided_examples', 'academy', true, 'c3', orch.store);

      orch.learningToLearn.trackAttempt('unstructured_text', 'academy', false, 'c_hard', orch.store);
      orch.learningToLearn.trackAttempt('unstructured_text', 'academy', false, 'c_hard', orch.store);
      orch.learningToLearn.trackAttempt('unstructured_text', 'academy', false, 'c_hard', orch.store);

      const best = orch.learningToLearn.suggestStrategy('academy', orch.store);
      assert(best === 'guided_examples', `best strategy identified as guided_examples (got ${best})`);
      const revisions = orch.learningToLearn.getDifficultConcepts(orch.store);
      assert(
        revisions.some((r) => r.conceptId === 'c_hard'),
        'repeatedly difficult concept flagged for revision'
      );
    }

    // ---------------------------------------------------------------- Test 9
    console.log('\nTest 9 — Duplicate Prevention');
    {
      const orch = new LearningOrchestrator({ storage: new MemoryStorage() });
      const text = 'Redis is an in-memory key-value data structure store.';
      for (let i = 0; i < 5; i++) {
        orch.enqueueConversation(text, 's9', 'conversation');
      }
      assert(orch.store.getQueue().length === 1, 'identical candidate enqueued only once');
      await orch.drainQueueCycle();
      assert(
        orch.store.getAllConcepts().filter((c) => c.label === 'Redis').length === 1,
        'only 1 Redis concept created'
      );
    }

    // ---------------------------------------------------------------- Test 10
    console.log('\nTest 10 — Resource Limits & Cancellation');
    {
      const orch = new LearningOrchestrator({
        storage: new MemoryStorage(),
        config: { maxQueueSize: 3, maxConcurrentTasks: 2 },
      });
      orch.cancelPending(); // pause processing so queue stays inspectable
      orch.resumeQueue();
      // Enqueue 5 distinct items directly via store to verify hard cap
      for (let i = 1; i <= 5; i++) {
        orch.store.enqueueItem(
          {
            id: `q_${i}`,
            type: 'intake',
            payload: {},
            priority: 1,
            createdAt: Date.now() + i,
            attempts: 0,
            maxAttempts: 2,
            idempotencyKey: `k_${i}`,
          },
          3,
          300_000
        );
      }
      assert(orch.store.getQueue().length <= 3, 'queue size capped at maxQueueSize=3');
      const cancelledCount = orch.cancelPending();
      assert(cancelledCount === 3, 'cancelPending clears all queued items');
      assert(orch.store.getQueue().length === 0, 'queue empty after cancellation');
    }

    // ---------------------------------------------------------------- Test 11
    console.log('\nTest 11 — Academy Integration Contract');
    {
      const orch = new LearningOrchestrator({ storage: new MemoryStorage() });
      const academy = orch.getAcademyService();
      const session = await academy.startGuidedSession({
        topic: 'Graph Theory',
        assessmentEnabled: true,
        lessons: [
          {
            topic: 'DAG',
            content: 'A DAG is a directed acyclic graph that requires Topological Sorting.',
            prerequisites: ['Topological Sorting'],
          },
        ],
      });
      assert(session.status === 'completed', 'guided session completed');
      assert(
        (session.outcome?.conceptsAcquired.length ?? 0) === 1,
        'guided session acquired DAG concept'
      );
      const queried = await academy.queryKnowledge('directed acyclic graph');
      assert(queried.length === 1, 'queryKnowledge returned DAG concept');
      const gap = await academy.explainKnowledgeGap(queried[0].id);
      assert(
        gap.missingPrerequisites.includes('Topological Sorting'),
        'explainKnowledgeGap surfaced missing prerequisite'
      );
    }

    // ---------------------------------------------------------------- Test 12
    console.log('\nTest 12 — Environmental Failure Distinction & Context Formatter');
    {
      const orch = new LearningOrchestrator({ storage: new MemoryStorage() });
      const envExp = orch.intake.identifyTaskOutcome(
        'task_env_1',
        false,
        'Fetch external weather report',
        ['research.search'],
        'network timeout 503'
      );
      assert(envExp.environmental === true, 'network timeout classified as environmental');
      const expOut = orch.experience.processExperience(envExp, orch.store);
      assert(
        (expOut.conceptsAcquired?.length ?? 0) === 0,
        'environmental failure does not falsely create negative lesson'
      );
      assert(formatLearningContext([], [], []) === '', 'empty learning context returns empty string');
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log(`\nLearning Mechanism test results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

void run();
