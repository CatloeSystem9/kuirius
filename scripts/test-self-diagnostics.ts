/**
 * Self-Diagnostics v1: Runtime Health and Failure Awareness — Dedicated Test Suite.
 *
 * Verifies:
 *  1. Diagnostic Registry: registration, bounds, lookup, unregister, duplicate rejection
 *  2. Check execution & status handling: healthy, degraded, unhealthy, unknown
 *  3. Error handling & corrupted data: malformed outcomes, check exceptions, evidence sanitization
 *  4. Passive-first & safety enforcement: no storage mutation, no synthetic events, no network
 *  5. Read-only active probes: opt-in flag (includeActiveProbes), excluded by default
 *  6. Core runtime checks: AgentCore availability, task lifecycle consistency, event bus buffer
 *  7. Intelligence subsystem checks: ContextEngine, KnowledgeGraph, Semantic, Memory, Consolidation, Learned Skills
 *  8. Execution subsystem checks: ToolRegistry integrity, planner wiring, recovery, permissions
 *  9. Model & routing checks: profile listing, router wiring without invocation, API key detection
 * 10. Persistence checks: read path, storage contract without calling mutators
 * 11. System consistency checks: subsystem interconnections, cycle trace store
 * 12. Failure Awareness Tracker: deduplication, fingerprinting, recurrence, recovery updates, eviction
 * 13. Diagnostic Diagnosis & Recommendations: hypotheses vs facts, affected capabilities
 * 14. Separation of health assessment and operational state: diagnosticStatus vs operationalState
 * 15. Diagnostic Tools: diagnostics.health & diagnostics.inspect Phase 3 contract & execution
 * 16. Full Bridge Integration: createAgentSystem, planner intent classification, cleanup
 *
 * Usage: npx tsx scripts/test-self-diagnostics.ts
 */

import {
  DiagnosticRegistry,
  FailureTracker,
  DiagnosticsService,
  createDiagnosticTools,
  createCoreChecks,
  createIntelligenceChecks,
  createExecutionChecks,
  createModelChecks,
  createPersistenceChecks,
  createSystemChecks,
  inferAffectedCapabilities,
  createFailureFingerprint,
} from '../src/agent/diagnostics';
import type {
  DiagnosticCheckDef,
  DiagnosticCheckOutcome,
  DiagnosticReport,
} from '../src/agent/diagnostics';

import { AgentEventBus } from '../src/agent/events';
import { SkillEngine } from '../src/agent/skills';
import { ProjectEngine } from '../src/agent/projects';
import { NodeProjectFs } from '../src/agent/projects/projectFsNode';
import { GoalEngine } from '../src/agent/goals';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { TaskStore, MemoryStorage, type StorageAdapter } from '../src/agent/taskState';
import { AgentCore } from '../src/agent/agentCore';
import { PermissionManager } from '../src/agent/permissions';
import { RecoveryManager } from '../src/agent/recovery';
import { HeuristicPlanner, classifyStep, classifyDiagnosticIntent, isDiagnosticIntent } from '../src/agent/planner';
import { ContextEngine } from '../src/agent/context/index';
import { KnowledgeGraphFacade } from '../src/agent/knowledge/index';
import { SemanticIntelligence } from '../src/agent/semantic/index';
import { MemoryService } from '../src/agent/memory/memoryService';
import { ConsolidationEngine } from '../src/agent/memory/consolidation/index';
import { ModelRouter } from '../src/agent/routing/router';
import { createDefaultModelRegistry } from '../src/agent/routing/modelProfiles';
import { getPerformanceTelemetry } from '../src/agent/routing/telemetry';
import { EmergencyStop, SafetyAuditLog, SafetyGate } from '../src/agent/safety';
import { createAgentSystem } from '../src/agent/bridge';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.error(`  FAIL: ${label}`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  assert(
    actual === expected,
    `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
  );
}

async function runTests(): Promise<void> {
  console.log('--- Krisha Self-Diagnostics v1 Test Suite ---');

  // =========================================================================
  // 1. Diagnostic Registry: registration, bounds, lookup, unregister
  // =========================================================================
  console.log('\n[1] Diagnostic Registry Operations');
  {
    const registry = new DiagnosticRegistry();
    const check1: DiagnosticCheckDef = {
      id: 'test.check.1',
      name: 'Test Check 1',
      subsystem: 'core',
      description: 'First test check',
      severity: 'informational',
      checkType: 'passive',
      run: () => ({ status: 'healthy', message: 'All good' }),
    };

    registry.register(check1);
    assertEqual(registry.list().length, 1, 'Registry contains registered check');
    assertEqual(registry.get('test.check.1')?.name, 'Test Check 1', 'Lookup by ID returns correct check');
    assertEqual(registry.findBySubsystem('core').length, 1, 'findBySubsystem works');
    assertEqual(registry.findBySubsystem('models').length, 0, 'findBySubsystem returns empty for non-matching');
    assertEqual(registry.findBySeverity('informational').length, 1, 'findBySeverity works');

    // Duplicate check ID rejection
    let threwDuplicate = false;
    try {
      registry.register(check1);
    } catch {
      threwDuplicate = true;
    }
    assert(threwDuplicate, 'Duplicate check ID registration throws error');

    // Unregister
    const unregistered = registry.unregister('test.check.1');
    assert(unregistered, 'unregister returns true for existing check');
    assertEqual(registry.list().length, 0, 'Registry empty after unregister');
    assert(!registry.unregister('non.existent'), 'unregister returns false for missing check');

    // Missing check ID error
    let threwMissingId = false;
    try {
      registry.register({} as any);
    } catch {
      threwMissingId = true;
    }
    assert(threwMissingId, 'Registering check without id throws error');
  }

  // =========================================================================
  // 2. Check execution & status handling (healthy, degraded, unhealthy, unknown)
  // =========================================================================
  console.log('\n[2] Check Execution & Status Handling');
  {
    const registry = new DiagnosticRegistry();
    registry.register({
      id: 'status.healthy',
      name: 'Healthy Check',
      subsystem: 'core',
      description: 'Returns healthy',
      severity: 'informational',
      checkType: 'passive',
      run: () => ({ status: 'healthy', message: 'Healthy output' }),
    });
    registry.register({
      id: 'status.degraded',
      name: 'Degraded Check',
      subsystem: 'intelligence',
      description: 'Returns degraded',
      severity: 'warning',
      checkType: 'passive',
      run: () => ({ status: 'degraded', message: 'Degraded output', remediation: 'Fix degraded state' }),
    });
    registry.register({
      id: 'status.unhealthy',
      name: 'Unhealthy Check',
      subsystem: 'execution',
      description: 'Returns unhealthy',
      severity: 'critical',
      checkType: 'passive',
      run: () => ({ status: 'unhealthy', message: 'Unhealthy output', remediation: 'Restart component' }),
    });
    registry.register({
      id: 'status.unknown',
      name: 'Unknown Check',
      subsystem: 'system',
      description: 'Returns unknown',
      severity: 'warning',
      checkType: 'passive',
      run: () => ({ status: 'unknown', message: 'Unknown output' }),
    });

    const resHealthy = registry.runCheck('status.healthy');
    assertEqual(resHealthy.status, 'healthy', 'Healthy check reports healthy status');
    assertEqual(resHealthy.message, 'Healthy output', 'Message matches');

    const resDegraded = registry.runCheck('status.degraded');
    assertEqual(resDegraded.status, 'degraded', 'Degraded check reports degraded status');
    assertEqual(resDegraded.remediation, 'Fix degraded state', 'Remediation preserved');

    const resUnhealthy = registry.runCheck('status.unhealthy');
    assertEqual(resUnhealthy.status, 'unhealthy', 'Unhealthy check reports unhealthy status');

    const resUnknown = registry.runCheck('status.unknown');
    assertEqual(resUnknown.status, 'unknown', 'Unknown check reports unknown status');

    // Unregistered check
    const resMissing = registry.runCheck('non.registered.id');
    assertEqual(resMissing.status, 'unknown', 'Unregistered check id returns unknown status');
  }

  // =========================================================================
  // 3. Error handling & corrupted data resilience
  // =========================================================================
  console.log('\n[3] Error Handling & Corrupted Diagnostic Data');
  {
    const registry = new DiagnosticRegistry();

    // Check throws unexpected exception
    registry.register({
      id: 'throws.error',
      name: 'Throwing Check',
      subsystem: 'core',
      description: 'Throws error',
      severity: 'critical',
      checkType: 'passive',
      run: () => {
        throw new Error('Simulated internal failure');
      },
    });

    const resError = registry.runCheck('throws.error');
    assertEqual(resError.status, 'unhealthy', 'Throwing check is caught and classified as unhealthy');
    assert(resError.message.includes('Simulated internal failure'), 'Error message preserved in result');
    assert(Boolean(resError.evidence), 'Evidence object populated with failure details');

    // Check returns invalid/malformed outcome
    registry.register({
      id: 'malformed.outcome',
      name: 'Malformed Outcome Check',
      subsystem: 'core',
      description: 'Returns invalid outcome',
      severity: 'warning',
      checkType: 'passive',
      run: () => ({ invalidField: true } as any),
    });

    const resMalformed = registry.runCheck('malformed.outcome');
    assertEqual(resMalformed.status, 'unhealthy', 'Malformed check outcome caught and reported as unhealthy');

    // Deeply nested evidence truncation
    const deeplyNested: any = { a: { b: { c: { d: { e: 'too_deep' } } } } };
    registry.register({
      id: 'nested.evidence',
      name: 'Nested Evidence Check',
      subsystem: 'core',
      description: 'Deep evidence',
      severity: 'informational',
      checkType: 'passive',
      run: () => ({ status: 'healthy', message: 'Ok', evidence: deeplyNested }),
    });

    const resNested = registry.runCheck('nested.evidence');
    assertEqual(resNested.status, 'healthy', 'Check with deep evidence succeeds');
    const dVal = (resNested.evidence as any)?.a?.b?.c;
    assertEqual(dVal, '[truncated]', 'Evidence nested past depth limit is safely truncated');
  }

  // =========================================================================
  // 4. Passive-first & safety enforcement (no mutations, no synthetic events)
  // =========================================================================
  console.log('\n[4] Passive-first & Strict Safety Enforcement');
  {
    const storage = new MemoryStorage();
    storage.setItem('krisha_agent_tasks_v1', 'existing_user_task_data');

    let setItemCalled = false;
    let removeItemCalled = false;
    const guardedStorage: StorageAdapter = {
      getItem: (k) => storage.getItem(k),
      setItem: (k, v) => {
        setItemCalled = true;
        storage.setItem(k, v);
      },
      removeItem: (k) => {
        removeItemCalled = true;
        storage.removeItem(k);
      },
    };

    const bus = new AgentEventBus();
    let eventsEmitted = 0;
    bus.on('NOTICE', () => { eventsEmitted++; });

    const checks = [
      ...createCoreChecks({ bus, store: new TaskStore(guardedStorage) }),
      ...createPersistenceChecks({ storage: guardedStorage }),
    ];

    const registry = new DiagnosticRegistry();
    registry.registerAll(checks);
    registry.runAll();

    assert(!setItemCalled, 'Default diagnostics NEVER call setItem (no storage mutation)');
    assert(!removeItemCalled, 'Default diagnostics NEVER call removeItem (no storage deletion)');
    assertEqual(eventsEmitted, 0, 'Default diagnostics emit 0 synthetic bus events');
    assertEqual(storage.getItem('krisha_agent_tasks_v1'), 'existing_user_task_data', 'Existing user data untouched');
  }

  // =========================================================================
  // 5. Read-only active probes: opt-in flag (includeActiveProbes)
  // =========================================================================
  console.log('\n[5] Read-Only Active Probes & Opt-In Filtering');
  {
    const registry = new DiagnosticRegistry();
    registry.register({
      id: 'passive.check',
      name: 'Passive Check',
      subsystem: 'core',
      description: 'Passive',
      severity: 'informational',
      checkType: 'passive',
      run: () => ({ status: 'healthy', message: 'Passive ok' }),
    });
    registry.register({
      id: 'active.probe',
      name: 'Active Probe',
      subsystem: 'intelligence',
      description: 'Active probe',
      severity: 'warning',
      checkType: 'active_probe',
      run: () => ({ status: 'healthy', message: 'Active probe executed safely' }),
    });

    // Default: passive only
    const defaultResults = registry.runAll();
    assertEqual(defaultResults.length, 1, 'Default runAll executes only passive checks');
    assertEqual(defaultResults[0].id, 'passive.check', 'Active probe excluded by default');

    // Opt-in: includeActiveProbes = true
    const probeResults = registry.runAll(undefined, { includeActiveProbes: true });
    assertEqual(probeResults.length, 2, 'runAll with includeActiveProbes executes both passive and active probes');
    assert(probeResults.some((r) => r.id === 'active.probe'), 'Active probe included when explicitly requested');
  }

  // =========================================================================
  // 6. Core runtime checks
  // =========================================================================
  console.log('\n[6] Core Runtime Layer Checks');
  {
    const storage = new MemoryStorage();
    const store = new TaskStore(storage);
    const bus = new AgentEventBus();
    const core = new AgentCore({
      registry: new ToolRegistry(bus),
      events: bus,
      store,
      permissions: new PermissionManager(),
    });

    const checks = createCoreChecks({ core, bus, store });
    const registry = new DiagnosticRegistry();
    registry.registerAll(checks);

    const results = registry.runAll();
    assertEqual(results.length, 3, 'Core checks count is 3');
    assert(results.every((r) => r.status === 'healthy'), 'All core checks healthy with valid dependencies');

    // Missing core dependency
    const brokenChecks = createCoreChecks({ core: undefined, bus, store });
    const brokenRegistry = new DiagnosticRegistry();
    brokenRegistry.registerAll(brokenChecks);
    const brokenResults = brokenRegistry.runAll();
    const availCheck = brokenResults.find((r) => r.id === 'core.runtime.availability');
    assertEqual(availCheck?.status, 'unhealthy', 'Core availability reports unhealthy when core is undefined');
  }

  // =========================================================================
  // 7. Intelligence subsystem checks
  // =========================================================================
  console.log('\n[7] Intelligence Subsystem Checks');
  {
    const storage = new MemoryStorage();
    const memory = new MemoryService(storage);
    const knowledgeGraph = new KnowledgeGraphFacade({ storage });
    const semantic = new SemanticIntelligence();
    const contextEngine = new ContextEngine({ memory, cacheStorage: storage });
    const consolidation = new ConsolidationEngine({
      memory,
      knowledge: knowledgeGraph.graph,
      semantic,
      storage,
    });

    const checks = createIntelligenceChecks({
      contextEngine,
      knowledgeGraph,
      semantic,
      memory,
      consolidation,
      skills: new SkillEngine({
        registry: new ToolRegistry(new AgentEventBus()),
        events: new AgentEventBus(),
        storage,
      }),
      projects: new ProjectEngine({ fs: new NodeProjectFs(), storage }),
      // Goal Continuity v1 — the passive goal-continuity check is part of the
      // intelligence registry, so the harness wires a real engine (same
      // pattern as skills/projects above).
      goals: new GoalEngine({ storage }),
    });

    const registry = new DiagnosticRegistry();
    registry.registerAll(checks);

    // Passive run
    const passiveResults = registry.runAll();
    assertEqual(passiveResults.length, 8, 'Passive intelligence checks count is 8');
    assert(passiveResults.every((r) => r.status === 'healthy'), 'All passive intelligence checks pass');

    // Active probe run (includes context_engine.probe and knowledge_graph.probe)
    const probeResults = registry.runAll(undefined, { includeActiveProbes: true });
    assertEqual(probeResults.length, 10, 'Intelligence checks with active probes count is 10');
    assert(probeResults.every((r) => r.status === 'healthy'), 'All intelligence active probes pass');

    // Missing contextEngine
    const degradedChecks = createIntelligenceChecks({
      contextEngine: undefined,
      knowledgeGraph,
      semantic,
      memory,
      consolidation,
    });
    const degRegistry = new DiagnosticRegistry();
    degRegistry.registerAll(degradedChecks);
    const degResults = degRegistry.runAll();
    const ceCheck = degResults.find((r) => r.id === 'intelligence.context_engine');
    assertEqual(ceCheck?.status, 'degraded', 'Missing context engine reports degraded');
  }

  // =========================================================================
  // 8. Execution subsystem checks
  // =========================================================================
  console.log('\n[8] Execution Layer Checks');
  {
    const bus = new AgentEventBus();
    const registry = new ToolRegistry(bus);
    registry.register({
      name: 'system.note',
      description: 'note',
      category: 'system',
      riskLevel: 'safe',
      capabilities: ['system.note'],
      permissions: [],
      execute: async () => ({ success: true, output: {} }),
    });
    registry.register({
      name: 'chat.report',
      description: 'report',
      category: 'system',
      riskLevel: 'safe',
      capabilities: ['communication.report'],
      permissions: [],
      execute: async () => ({ success: true, output: {} }),
    });

    const planner = new HeuristicPlanner();
    const permissions = new PermissionManager();
    const recovery = new RecoveryManager({ registry, events: bus, permissions });

    const checks = createExecutionChecks({ registry, planner, recovery, permissions });
    const diagRegistry = new DiagnosticRegistry();
    diagRegistry.registerAll(checks);

    const results = diagRegistry.runAll();
    assertEqual(results.length, 4, 'Execution checks count is 4');
    assert(results.every((r) => r.status === 'healthy'), 'All execution checks pass');

    // Active planner probe
    const probeResults = diagRegistry.runAll(undefined, { includeActiveProbes: true });
    assertEqual(probeResults.length, 5, 'Execution checks with planner probe count is 5');
    assert(probeResults.every((r) => r.status === 'healthy'), 'Execution active probe passes');

    // Missing permissions
    const brokenPermChecks = createExecutionChecks({ registry, planner, recovery, permissions: undefined });
    const brokenRegistry = new DiagnosticRegistry();
    brokenRegistry.registerAll(brokenPermChecks);
    const permResult = brokenRegistry.runCheck('execution.permissions');
    assertEqual(permResult.status, 'unhealthy', 'Missing permissions reports unhealthy');
  }

  // =========================================================================
  // 9. Model & routing checks (no network calls)
  // =========================================================================
  console.log('\n[9] Model & Routing Layer Checks');
  {
    const telemetry = getPerformanceTelemetry();
    const modelRegistry = createDefaultModelRegistry();
    const router = new ModelRouter(modelRegistry, telemetry);

    const checks = createModelChecks({ router, registry: modelRegistry });
    const diagRegistry = new DiagnosticRegistry();
    diagRegistry.registerAll(checks);

    const results = diagRegistry.runAll();
    assertEqual(results.length, 4, 'Model checks count is 4');
    const profileCheck = results.find((r) => r.id === 'models.registry.profiles');
    assertEqual(profileCheck?.status, 'healthy', 'Profiles check reports healthy with loaded profiles');

    const routerCheck = results.find((r) => r.id === 'models.routing.config');
    assertEqual(routerCheck?.status, 'healthy', 'Router check passes without invoking model');
    assertEqual(routerCheck?.evidence?.modelInvocation, false, 'Verified zero model invocations');
  }

  // =========================================================================
  // 10. Persistence checks (storage contract without mutators)
  // =========================================================================
  console.log('\n[10] Persistence Layer Checks');
  {
    const storage = new MemoryStorage();
    const checks = createPersistenceChecks({ storage });
    const diagRegistry = new DiagnosticRegistry();
    diagRegistry.registerAll(checks);

    const results = diagRegistry.runAll();
    assertEqual(results.length, 2, 'Persistence checks count is 2');
    assert(results.every((r) => r.status === 'healthy'), 'All persistence checks pass');

    // Missing storage adapter
    const brokenChecks = createPersistenceChecks({ storage: undefined });
    const brokenRegistry = new DiagnosticRegistry();
    brokenRegistry.registerAll(brokenChecks);
    const brokenRes = brokenRegistry.runCheck('persistence.storage_adapter');
    assertEqual(brokenRes.status, 'unknown', 'Missing storage reports unknown status');
  }

  // =========================================================================
  // 11. System consistency checks
  // =========================================================================
  console.log('\n[11] System Consistency Checks');
  {
    const bus = new AgentEventBus();
    const store = new TaskStore(new MemoryStorage());
    const registry = new ToolRegistry(bus);
    const permissions = new PermissionManager();
    const core = new AgentCore({ registry, events: bus, store, permissions });

    const checks = createSystemChecks({ core, registry, bus, permissions, store });
    const diagRegistry = new DiagnosticRegistry();
    diagRegistry.registerAll(checks);

    const results = diagRegistry.runAll();
    assertEqual(results.length, 2, 'System checks count is 2');
    assert(results.every((r) => r.status === 'healthy'), 'All system consistency checks pass');
  }

  // =========================================================================
  // 12. Failure Awareness Tracker
  // =========================================================================
  console.log('\n[12] Failure Awareness Tracker');
  {
    const tracker = new FailureTracker(10);

    // Initial failure
    const rec1 = tracker.recordFailure({
      subsystem: 'execution',
      source: 'filesystem.read',
      error: 'File not found: resume.pdf',
      taskId: 'task_1',
      stepId: 'step_1',
      toolName: 'filesystem.read',
      recoveryOutcome: 'none',
    });
    assertEqual(rec1.occurrences, 1, 'Initial failure has occurrences = 1');
    assertEqual(tracker.count(), 1, 'Tracker has 1 record');

    // Repeated failure (identical normalized error) -> deduplicated
    const rec2 = tracker.recordFailure({
      subsystem: 'execution',
      source: 'filesystem.read',
      error: 'File not found: resume.pdf',
      taskId: 'task_2',
      stepId: 'step_2',
      toolName: 'filesystem.read',
    });
    assertEqual(rec2.occurrences, 2, 'Deduplicated failure increments occurrence count');
    assertEqual(tracker.count(), 1, 'Tracker still has 1 unique record');

    // Update recovery outcome
    tracker.updateRecoveryOutcome('task_2', 'succeeded', 'step_2');
    const updated = tracker.list()[0];
    assertEqual(updated.lastRecoveryOutcome, 'succeeded', 'Recovery outcome updated on failure record');

    // Capacity bound and eviction
    for (let i = 0; i < 15; i++) {
      tracker.recordFailure({
        subsystem: 'models',
        source: `provider_${i}`,
        error: `Unique error message number ${i}`,
      });
    }
    assert(tracker.count() <= 10, 'FailureTracker maintains hard upper bound on records');
  }

  // =========================================================================
  // 13. Diagnostic Diagnosis & Recommendations
  // =========================================================================
  console.log('\n[13] Diagnostic Diagnosis & Recommendations');
  {
    const tracker = new FailureTracker();

    // Permission denied failure
    tracker.recordFailure({
      subsystem: 'execution',
      source: 'filesystem.write',
      error: 'Permission denied: write access blocked',
      taskId: 'task_p1',
    });

    // Timeout failure
    tracker.recordFailure({
      subsystem: 'models',
      source: 'gemini.generate',
      error: 'Operation timed out after 30000ms',
      taskId: 'task_t1',
    });

    const issues = tracker.diagnoseIssues();
    assertEqual(issues.length, 2, 'Diagnosed 2 issues from tracked failures');

    const permIssue = issues.find((i) => i.subsystem === 'execution');
    assert(Boolean(permIssue), 'Found execution permission issue');
    assertEqual(permIssue?.isHypothesis, false, 'Permission issue likely cause is not marked hypothesis (fact)');
    assertEqual(permIssue?.userInterventionRequired, true, 'Permission issue flags user intervention required');

    const timeoutIssue = issues.find((i) => i.subsystem === 'models');
    assert(Boolean(timeoutIssue), 'Found model timeout issue');
    assertEqual(timeoutIssue?.isHypothesis, true, 'Timeout issue likely cause is clearly labelled hypothesis');
  }

  // =========================================================================
  // 14. Separation of health assessment and operational state
  // =========================================================================
  console.log('\n[14] Health Assessment vs Operational State Separation');
  {
    const storage = new MemoryStorage();
    const bus = new AgentEventBus();
    const store = new TaskStore(storage);
    const registry = new ToolRegistry(bus);
    const permissions = new PermissionManager();
    const core = new AgentCore({ registry, events: bus, store, permissions });

    const audit = new SafetyAuditLog();
    const emergencyStop = new EmergencyStop(audit);

    const service = new DiagnosticsService({
      core,
      bus,
      registry,
      store,
      storage,
      permissions,
      emergencyStop,
    });

    // Initial state: 0 active tasks, emergency stop inactive
    const report1 = await service.generateReport({ refresh: true });
    assertEqual(report1.operationalState.activeTaskCount, 0, 'Active task count initially 0');
    assertEqual(report1.operationalState.emergencyStopActive, false, 'Emergency stop initially inactive');
    assertEqual(report1.operationalState.unavailableSources.length, 0, 'No unavailable operational sources');

    // Simulate emergency stop activation
    emergencyStop.activate('Diagnostic safety drill');
    const report2 = await service.generateReport({ refresh: true });
    assertEqual(report2.operationalState.emergencyStopActive, true, 'Operational snapshot detects emergency stop active');
    // Note: operational emergency stop is an OPERATIONAL state, not a subsystem component crash
    assert(report2.operationalState.observedAt > 0, 'Operational state observed timestamp present');

    emergencyStop.deactivate();
  }

  // =========================================================================
  // 15. Diagnostic Tools (diagnostics.health & diagnostics.inspect)
  // =========================================================================
  console.log('\n[15] Diagnostic Agent Tools (Phase 3 Contract)');
  {
    const storage = new MemoryStorage();
    const bus = new AgentEventBus();
    const service = new DiagnosticsService({ bus, storage });
    const tools = createDiagnosticTools(service);

    assertEqual(tools.length, 2, 'createDiagnosticTools creates 2 tools');
    const healthTool = tools.find((t) => t.name === 'diagnostics.health');
    const inspectTool = tools.find((t) => t.name === 'diagnostics.inspect');

    assert(Boolean(healthTool), 'diagnostics.health tool exists');
    assert(Boolean(inspectTool), 'diagnostics.inspect tool exists');
    assertEqual(healthTool?.riskLevel, 'safe', 'diagnostics.health is declared safe');
    assertEqual(healthTool?.cost, 'free', 'diagnostics.health is declared free');

    // Execute diagnostics.health
    const healthResult = await healthTool!.execute({}, {} as any);
    assert(healthResult.success, 'diagnostics.health execution succeeds');
    const healthOutput = (healthResult as any).output;
    assert(Boolean(healthOutput.diagnosticStatus), 'health output contains diagnosticStatus');
    assert(Boolean(healthOutput.subsystemHealth), 'health output contains subsystemHealth');
    assert(Boolean(healthOutput.operationalState), 'health output contains operationalState');

    // Execute diagnostics.inspect for a specific subsystem
    const inspectResult = await inspectTool!.execute({ subsystem: 'core' }, {} as any);
    assert(inspectResult.success, 'diagnostics.inspect execution succeeds');
    const inspectOutput = (inspectResult as any).output;
    assertEqual(inspectOutput.subsystem, 'core', 'inspect output filtered by subsystem');
    assert(Array.isArray(inspectOutput.checks), 'inspect output includes checks array');
  }

  // =========================================================================
  // 16. Full Bridge Integration & Planner Routing
  // =========================================================================
  console.log('\n[16] Bridge Integration & Planner Intent Routing');
  {
    // Test planner classification for diagnostic requests
    const stepHealth = classifyStep('check system health');
    assertEqual(stepHealth?.toolName, 'diagnostics.health', 'Planner classifies "check system health" to diagnostics.health');

    const stepInspect = classifyStep('inspect the core subsystem');
    assertEqual(stepInspect?.toolName, 'diagnostics.inspect', 'Planner classifies "inspect the core subsystem" to diagnostics.inspect');

    assert(isDiagnosticIntent('run diagnostics'), 'isDiagnosticIntent returns true for "run diagnostics"');
    assert(!isDiagnosticIntent('open youtube.com'), 'isDiagnosticIntent returns false for unrelated queries');

    // Instantiate full AgentSystem via bridge
    const system = createAgentSystem({
      applyWebAction: () => {},
      applyAppAction: () => {},
      applyFileAction: () => {},
      applyMapsAction: () => {},
      applyViewerFile: () => {},
      applyGlobeAction: () => {},
      openModal: () => {},
      setPose: () => {},
    });

    assert(Boolean(system.diagnostics), 'AgentSystem exposes diagnostics service');
    assert(system.core.registry.has('diagnostics.health'), 'diagnostics.health registered in ToolRegistry');
    assert(system.core.registry.has('diagnostics.inspect'), 'diagnostics.inspect registered in ToolRegistry');

    const fullReport = await system.diagnostics!.generateReport();
    assert(Boolean(fullReport.diagnosticStatus), 'Bridge diagnostics generates report successfully');
    assertEqual(fullReport.metrics.totalChecks >= 15, true, 'At least 15 checks registered and run');

    // Clean teardown
    system.detach();
    assert(true, 'System detaches cleanly without errors');
  }

  // =========================================================================
  // Summary
  // =========================================================================
  console.log('\n=============================================');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('Failures:', failures);
    process.exit(1);
  } else {
    console.log('SELF-DIAGNOSTICS V1 TESTS: ALL GREEN');
  }
}

runTests().catch((err) => {
  console.error('Unexpected test error:', err);
  process.exit(1);
});
