/**
 * Real-machine verification (Phase 10 — Multi-Step Autonomy).
 * Safe and fully reversible: all operations take place within an isolated
 * temporary directory in %TEMP%.
 *
 * Demonstrates:
 * 1. Multi-step autonomous plan execution (6 steps).
 * 2. Real filesystem operations (create dir, create file, search, read, verify, cleanup).
 * 3. Dynamic context chaining ($context references resolved at runtime).
 * 4. Automatic cleanup and verification.
 *
 * Usage: npx tsx scripts/real-machine-check-autonomy.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { AgentCore } from '../src/agent/agentCore';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { TaskStore, MemoryStorage } from '../src/agent/taskState';
import { PermissionManager } from '../src/agent/permissions';
import { AgentEventBus } from '../src/agent/events';
import { HeuristicPlanner, extractGoal } from '../src/agent/planner';
import { ok } from '../src/agent/types';
import type { PlanStep, AgentPlan } from '../src/agent/types';

const stamp = Date.now();
const tempRoot = process.env.TEMP || 'C:\\Windows\\Temp';
const testDir = path.join(tempRoot, `krisha-phase10-autonomy-${stamp}`);
const testFileName = `autonomy-marker-${stamp}.txt`;
const testFilePath = path.join(testDir, testFileName);
const markerContent = `Krisha Phase 10 autonomous execution token: ${stamp}`;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.error(`  ✗ ${label}`);
  }
}

async function main() {
  console.log('--- Krisha Phase 10 Real-Machine Autonomy Check ---');
  console.log('Test directory:', testDir);

  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  const permissions = new PermissionManager();
  permissions.grant('filesystem.read');
  permissions.grant('filesystem.write');



  // Register real tools operating within the isolated test boundary
  registry.register({
    name: 'fs.create_dir',
    description: 'Create test directory',
    category: 'filesystem',
    riskLevel: 'low',
    permissions: ['filesystem.write'],
    async execute(input) {
      const dirPath = String(input.path);
      await fs.promises.mkdir(dirPath, { recursive: true });
      return ok({ output: { created: true, path: dirPath } });
    },
  });

  registry.register({
    name: 'fs.create_file',
    description: 'Create test file with content',
    category: 'filesystem',
    riskLevel: 'low',
    permissions: ['filesystem.write'],
    async execute(input) {
      const targetPath = String(input.path);
      const content = String(input.content);
      await fs.promises.writeFile(targetPath, content, 'utf8');
      return ok({ output: { created: true, path: targetPath, size: content.length } });
    },
  });

  registry.register({
    name: 'fs.search',
    description: 'Search directory for a file by name',
    category: 'filesystem',
    riskLevel: 'low',
    permissions: ['filesystem.read'],
    async execute(input) {
      const searchDir = String(input.directory);
      const query = String(input.query);
      const entries = await fs.promises.readdir(searchDir);
      const matches = entries
        .filter((e) => e.includes(query))
        .map((e) => ({ name: e, path: path.join(searchDir, e) }));
      return ok({ output: { count: matches.length, matches } });
    },
  });

  registry.register({
    name: 'fs.read',
    description: 'Read file content',
    category: 'filesystem',
    riskLevel: 'low',
    permissions: ['filesystem.read'],
    async execute(input) {
      const targetPath = String(input.path);
      const content = await fs.promises.readFile(targetPath, 'utf8');
      return ok({ output: { path: targetPath, content } });
    },
  });

  registry.register({
    name: 'fs.cleanup',
    description: 'Safely remove test directory',
    category: 'filesystem',
    riskLevel: 'low',
    permissions: ['filesystem.write'],
    async execute(input) {
      const dirPath = String(input.path);
      if (fs.existsSync(dirPath)) {
        await fs.promises.rm(dirPath, { recursive: true, force: true });
      }
      return ok({ output: { cleaned: true } });
    },
  });

  const store = new TaskStore(new MemoryStorage());

  try {
    // 1. Multi-step plan execution (6 steps with context chaining)
    console.log('\nStep 1-6: Executing autonomous multi-step workflow...');
    const goal = extractGoal('execute 6-step autonomous file creation, search, verification, and cleanup');

    const steps: PlanStep[] = [
      {
        id: 'step_1_mkdir',
        description: 'Create isolated test directory',
        toolName: 'fs.create_dir',
        input: { path: testDir },
        status: 'pending',
        attempts: 0,
      },
      {
        id: 'step_2_write',
        description: 'Write marker file',
        toolName: 'fs.create_file',
        input: { path: testFilePath, content: markerContent },
        status: 'pending',
        attempts: 0,
      },
      {
        id: 'step_3_search',
        description: 'Search for marker file',
        toolName: 'fs.search',
        input: { directory: testDir, query: testFileName },
        outputKey: 'found',
        status: 'pending',
        attempts: 0,
      },
      {
        id: 'step_4_read',
        description: 'Read discovered file via chained context',
        toolName: 'fs.read',
        input: { path: { $context: 'found.matches.0.path' } },
        outputKey: 'fileData',
        status: 'pending',
        attempts: 0,
      },
      {
        id: 'step_5_verify',
        description: 'Verify marker content exists in fileData',
        toolName: 'fs.read',
        condition: { kind: 'context_contains', key: 'fileData.content', value: markerContent },
        input: { path: { $context: 'found.matches.0.path' } },
        outputKey: 'verification',
        status: 'pending',
        attempts: 0,
      },
      {
        id: 'step_6_cleanup',
        description: 'Clean up test directory',
        toolName: 'fs.cleanup',
        input: { path: testDir },
        status: 'pending',
        attempts: 0,
      },
    ];

    class FixedRealPlanner {
      makePlan(g: typeof goal): AgentPlan {
        return {
          goal: g,
          steps,
          createdAt: Date.now(),
          revision: 1,
          objective: 'autonomous file lifecycle',
        };
      }
      proposeAlternative() { return null; }
    }

    const autonomousCore = new AgentCore({
      registry,
      events: bus,
      store,
      permissions,
      planner: new FixedRealPlanner(),
    });

    const task = await autonomousCore.submit(goal.rawInput);

    assert(task.status === 'completed', 'autonomous task completed successfully');
    assert(task.plan!.steps.length === 6, 'all 6 steps were planned');
    assert(task.plan!.steps.every((s) => s.status === 'completed'), 'every step executed and completed');
    assert(task.context !== undefined, 'task context scratchpad persisted');
    assert((task.context as any).found?.matches?.[0]?.path === testFilePath, 'step 3 found the exact file path');
    assert((task.context as any).fileData?.content === markerContent, 'step 4 chained path and read content accurately');
    assert((task.context as any).verification !== undefined, 'step 5 run condition satisfied and verified');
    assert(!fs.existsSync(testDir), 'step 6 completely cleaned up the temporary directory');
    const recentEventNames = bus.recentEvents().map((e) => e.name);
    assert(recentEventNames.includes('TASK_STARTED') && recentEventNames.includes('TASK_COMPLETED'), 'event bus tracked lifecycle');

    // 2. Test Planner Natural Language Decomposition with Context Chaining
    console.log('\nPlanner test: End-to-end natural language chaining...');
    const planner = new HeuristicPlanner();
    const chainedPlan = planner.makePlan(extractGoal('search the filesystem for my-doc.txt then read my-doc.txt'));
    assert(chainedPlan.steps[0].toolName === 'filesystem.search', 'planner generated filesystem.search');
    assert(chainedPlan.steps[0].outputKey === 'found', 'planner set outputKey = found on search step');
    assert(chainedPlan.steps[1].toolName === 'filesystem.read', 'planner generated filesystem.read');
    assert(
      JSON.stringify((chainedPlan.steps[1].input as any).path) === JSON.stringify({ $context: 'found.matches.0.path' }),
      'planner chained $context reference into read step'
    );
    assert(chainedPlan.objective !== undefined, 'planner set plan objective');

  } finally {
    // Failsafe cleanup
    if (fs.existsSync(testDir)) {
      try {
        fs.rmSync(testDir, { recursive: true, force: true });
      } catch {}
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('FAILURES:\n' + failures.map((f) => ` - ${f}`).join('\n'));
    process.exit(1);
  }
  console.log('REAL-MACHINE AUTONOMY CHECK: ALL GREEN');
}

main().catch((err) => {
  console.error('Fatal error in real-machine autonomy check:', err);
  process.exit(1);
});
