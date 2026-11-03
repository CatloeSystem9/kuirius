/**
 * Self-Diagnostics v1: Diagnostics Service.
 *
 * Central coordinator for runtime health checks, failure awareness, and
 * verified diagnostic reporting for Krisha.
 */

import type { AgentEventBus, AgentEvent } from '../events';
import type { AgentCore } from '../agentCore';
import type { ToolRegistry } from '../toolRegistry';
import type { TaskStore } from '../taskState';
import type { StorageAdapter } from '../taskState';
import type { PermissionManager } from '../permissions';
import type { ContextEngine } from '../context/contextEngine';
import type { KnowledgeGraphFacade } from '../knowledge';
import type { SemanticIntelligence } from '../semantic/semanticExpander';
import type { MemoryService } from '../memory/memoryService';
import type { ConsolidationEngine } from '../memory/consolidation/consolidationEngine';
import type { RecoveryManager } from '../recovery';
import type { Planner } from '../planner';
import type { ModelRouter } from '../routing/router';
import type { ModelRegistry } from '../routing/modelProfiles';
import type { SafetyGate } from '../safety';
import type { EmergencyStop } from '../safety/emergencyStop';

import { DiagnosticRegistry } from './diagnosticRegistry';
import { FailureTracker } from './failureTracker';
import type {
  DiagnosticCheckDef,
  DiagnosticCheckResult,
  DiagnosticReport,
  DiagnosticRunMode,
  DiagnosticStatus,
  FailureEvent,
  FailureRecord,
  IssueDiagnosis,
  OperationalStateSnapshot,
  SubsystemName,
} from './diagnosticTypes';

import { createCoreChecks } from './checks/coreChecks';
import { createIntelligenceChecks } from './checks/intelligenceChecks';
import { createExecutionChecks } from './checks/executionChecks';
import { createModelChecks } from './checks/modelChecks';
import { createPersistenceChecks } from './checks/persistenceChecks';
import { createSystemChecks } from './checks/systemChecks';

export interface DiagnosticsServiceDeps {
  core?: AgentCore;
  bus?: AgentEventBus;
  registry?: ToolRegistry;
  store?: TaskStore;
  storage?: StorageAdapter;
  permissions?: PermissionManager;
  contextEngine?: ContextEngine;
  knowledgeGraph?: KnowledgeGraphFacade;
  semantic?: SemanticIntelligence;
  memory?: MemoryService;
  consolidation?: ConsolidationEngine;
  /** Learned Skills v1 — validated reusable-capability engine. */
  skills?: import('../skills').SkillEngine;
  /** Project Awareness v1 — read-only understanding of approved projects. */
  projects?: import('../projects').ProjectEngine;
  recovery?: RecoveryManager;
  planner?: Planner;
  router?: ModelRouter;
  modelRegistry?: ModelRegistry;
  safetyGate?: SafetyGate;
  emergencyStop?: EmergencyStop;
}

export class DiagnosticsService {
  readonly registry: DiagnosticRegistry;
  readonly failureTracker: FailureTracker;
  private busListeners: (() => void)[] = [];
  private reportsByMode = new Map<DiagnosticRunMode, DiagnosticReport>();
  private readonly reportCacheTtlMs = 5000;

  constructor(private readonly deps: DiagnosticsServiceDeps = {}) {
    this.registry = new DiagnosticRegistry();
    this.failureTracker = new FailureTracker();

    // Register all standard layered health checks
    this.registry.registerAll(createCoreChecks(deps));
    this.registry.registerAll(createIntelligenceChecks(deps));
    this.registry.registerAll(createExecutionChecks(deps));
    this.registry.registerAll(createModelChecks({ router: deps.router, modelRegistry: deps.modelRegistry }));
    this.registry.registerAll(createPersistenceChecks(deps));
    this.registry.registerAll(createSystemChecks(deps));

    if (deps.bus) {
      this.attach(deps.bus);
    }
  }

  /**
   * Listen to operational events on the shared bus for passive failure awareness.
   */
  attach(bus: AgentEventBus): () => void {
    // Unsubscribe any previous listeners
    for (const off of this.busListeners) off();
    this.busListeners = [];

    const onToolFailed = bus.on('TOOL_FAILED', (event: AgentEvent) => {
      const payload = event.payload as { error?: string; tool?: string; errorKind?: string } | undefined;
      const toolName = payload?.tool || 'unknown_tool';
      const errorMsg = payload?.error || 'Tool execution failed';
      this.failureTracker.recordFailure({
        subsystem: 'execution',
        source: toolName,
        error: errorMsg,
        taskId: event.taskId,
        stepId: event.stepId,
        toolName,
        timestamp: event.timestamp,
        recoveryOutcome: 'none',
      });
    });

    const onTaskFailed = bus.on('TASK_FAILED', (event: AgentEvent) => {
      const payload = event.payload as { error?: string; reason?: string } | undefined;
      const errorMsg = payload?.error || payload?.reason || 'Task execution failed';
      this.failureTracker.recordFailure({
        subsystem: 'core',
        source: 'agent_task',
        error: errorMsg,
        taskId: event.taskId,
        timestamp: event.timestamp,
        recoveryOutcome: 'none',
      });
    });

    const onRecoveryFailed = bus.on('RECOVERY_FAILED', (event: AgentEvent) => {
      const payload = event.payload as { error?: string; strategy?: string } | undefined;
      const errorMsg = payload?.error || 'Recovery strategy failed';
      this.failureTracker.recordFailure({
        subsystem: 'execution',
        source: 'recovery_manager',
        error: errorMsg,
        taskId: event.taskId,
        stepId: event.stepId,
        timestamp: event.timestamp,
        recoveryOutcome: 'failed',
      });
      if (event.taskId) {
        this.failureTracker.updateRecoveryOutcome(event.taskId, 'failed', event.stepId);
      }
    });

    const onRecoverySucceeded = bus.on('RECOVERY_SUCCEEDED', (event: AgentEvent) => {
      if (event.taskId) {
        this.failureTracker.updateRecoveryOutcome(event.taskId, 'succeeded', event.stepId);
      }
    });

    const onFsFailed = bus.on('FS_OPERATION_FAILED', (event: AgentEvent) => {
      const payload = event.payload as { error?: string; op?: string } | undefined;
      this.failureTracker.recordFailure({
        subsystem: 'execution',
        source: `filesystem.${payload?.op || 'operation'}`,
        error: payload?.error || 'Filesystem operation failed',
        taskId: event.taskId,
        timestamp: event.timestamp,
      });
    });

    const onAppFailed = bus.on('APP_LAUNCH_FAILED', (event: AgentEvent) => {
      const payload = event.payload as { error?: string; app?: string } | undefined;
      this.failureTracker.recordFailure({
        subsystem: 'execution',
        source: `application.launch:${payload?.app || 'unknown'}`,
        error: payload?.error || 'Application launch failed',
        taskId: event.taskId,
        timestamp: event.timestamp,
      });
    });

    this.busListeners = [
      onToolFailed,
      onTaskFailed,
      onRecoveryFailed,
      onRecoverySucceeded,
      onFsFailed,
      onAppFailed,
    ];

    return () => {
      for (const off of this.busListeners) off();
      this.busListeners = [];
    };
  }

  recordFailure(event: FailureEvent): void {
    this.failureTracker.recordFailure(event);
  }

  getRecentFailures(limit?: number): FailureRecord[] {
    const list = this.failureTracker.list();
    return limit ? list.slice(0, Math.max(1, Math.min(limit, 20))) : list.slice(0, 20);
  }

  getIssues(): IssueDiagnosis[] {
    return this.failureTracker.diagnoseIssues();
  }

  /**
   * Run local diagnostics on demand. The default is a passive, read-only report.
   * Cached reports are clearly labeled so a prior diagnostic assessment is never
   * mistaken for a live operational-state observation.
   */
  async generateReport(options: { refresh?: boolean; includeActiveProbes?: boolean } = {}): Promise<DiagnosticReport> {
    const now = Date.now();
    const runMode: DiagnosticRunMode = options.includeActiveProbes ? 'manual_probe' : 'passive';
    const cached = this.reportsByMode.get(runMode);
    if (!options.refresh && cached && now - cached.timestamp < this.reportCacheTtlMs) {
      return {
        ...cached,
        cache: { source: 'cache', ageMs: now - cached.timestamp },
      };
    }

    const start = Date.now();
    const checkResults = this.registry.runAll(undefined, { includeActiveProbes: options.includeActiveProbes });
    const durationMs = Date.now() - start;

    const subsystemHealth: Record<SubsystemName, DiagnosticStatus> = {
      core: 'healthy',
      intelligence: 'healthy',
      execution: 'healthy',
      models: 'healthy',
      persistence: 'healthy',
      system: 'healthy',
    };

    let healthyCount = 0;
    let degradedCount = 0;
    let unhealthyCount = 0;
    let unknownCount = 0;

    for (const res of checkResults) {
      if (res.status === 'healthy') healthyCount++;
      else if (res.status === 'degraded') degradedCount++;
      else if (res.status === 'unhealthy') unhealthyCount++;
      else unknownCount++;

      // Aggregate subsystem health: worst status wins
      const current = subsystemHealth[res.subsystem];
      if (res.status === 'unhealthy') {
        subsystemHealth[res.subsystem] = 'unhealthy';
      } else if (res.status === 'degraded' && current !== 'unhealthy') {
        subsystemHealth[res.subsystem] = 'degraded';
      } else if (res.status === 'unknown' && current === 'healthy') {
        subsystemHealth[res.subsystem] = 'unknown';
      }
    }

    // Determine overall status
    let overallStatus: DiagnosticStatus = 'healthy';
    if (unhealthyCount > 0) {
      overallStatus = 'unhealthy';
    } else if (degradedCount > 0) {
      overallStatus = 'degraded';
    } else if (unknownCount > 0 && healthyCount === 0) {
      overallStatus = 'unknown';
    }

    const activeIssues = this.failureTracker.diagnoseIssues().slice(0, 20);
    const recentFailures = this.failureTracker.list().slice(0, 20);

    const summary = overallStatus === 'healthy'
      ? `Diagnostic assessment is healthy (${healthyCount}/${checkResults.length} checks passed).`
      : overallStatus === 'degraded'
      ? `Diagnostic assessment is degraded (${degradedCount} degraded check(s), ${activeIssues.length} tracked issue(s)).`
      : `Diagnostic assessment found ${unhealthyCount} unhealthy check(s) and ${activeIssues.length} tracked issue(s).`;

    const report: DiagnosticReport = {
      diagnosticStatus: overallStatus,
      overallStatus,
      summary,
      timestamp: now,
      durationMs,
      runMode,
      cache: { source: 'fresh', ageMs: 0 },
      operationalState: this.observeOperationalState(now),
      subsystemHealth,
      checkResults,
      activeIssues,
      recentFailures,
      metrics: {
        totalChecks: checkResults.length,
        healthyChecks: healthyCount,
        degradedChecks: degradedCount,
        unhealthyChecks: unhealthyCount,
        unknownChecks: unknownCount,
        trackedFailureCount: this.failureTracker.count(),
        reportedFailureCount: recentFailures.length,
      },
    };

    this.reportsByMode.set(runMode, report);
    return report;
  }

  /** Read control-plane state without treating it as a diagnostic conclusion. */
  private observeOperationalState(observedAt: number): OperationalStateSnapshot {
    const unavailableSources: string[] = [];
    const state: OperationalStateSnapshot = { observedAt, unavailableSources };

    if (this.deps.core) {
      state.activeTaskCount = this.deps.core.getActiveTaskCount();
    } else {
      unavailableSources.push('AgentCore active-task snapshot');
    }

    if (this.deps.emergencyStop) {
      state.emergencyStopActive = this.deps.emergencyStop.isActive();
    } else {
      unavailableSources.push('EmergencyStop state');
    }

    return state;
  }
}
