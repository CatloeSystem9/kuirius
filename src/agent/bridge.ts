/**
 * Agent bridge (Phase 1) — the only place the Agent Core touches the existing app.
 *
 * The App registers host callbacks (the same setters it already uses for its
 * action cards); the bridge applies declarative UiEffects emitted by tool
 * results onto those existing mechanisms. No UI components are modified.
 */
import type { AgentTask, UiEffect } from './types';
import type { AgentEvent } from './events';
import { AgentEventBus } from './events';
import { ToolRegistry } from './toolRegistry';
import { TaskStore, localStorageAdapter } from './taskState';
import { AgentCore } from './agentCore';
import { PermissionManager } from './permissions';
import { createBrowserTools } from './browserTools';
import { createScreenTools } from './vision/screenTools';
import { ScreenObserver } from './vision/screenObserver';
import { BrowserCaptureSource } from './vision/browserCapture';
import { isMultiStepRequest, isScreenIntent, isMouseIntent, isKeyboardIntent, isSystemIntent, isResearchIntent, HeuristicPlanner } from './planner';
import { LearningService } from './learning/learningService';
import { WorkflowAwarePlanner } from './learning/workflowPlanner';
import { SkillEngine, SkillAwarePlanner, createSkillTools } from './skills';
import { getMemoryService } from './memory/memoryService';
import { ConsolidationEngine } from './memory/consolidation';
import { ComputerControlService } from './computer/computerControl';
import { PowerShellMouseBackend } from './computer/powerShellMouse';
import { createMouseTools } from './computer/mouseTools';
import { KeyboardControlService } from './computer/keyboardControl';
import { PowerShellKeyboardBackend } from './computer/powerShellKeyboard';
import { createKeyboardTools } from './computer/keyboardTools';
import { ComputerUseAgent } from './computerUse/computerUseAgent';
import { createComputerUseTools } from './computerUse/computerUseTools';
import { AdaptiveObserver } from './observation/adaptiveObserver';
import { BrowserAgent } from './browser/browserAgent';
import { MultimodalService } from './multimodal/multimodalService';
import { ProactiveService } from './proactive/proactiveService';
import { PlanEngine } from './planning';
import { ContextEngine } from './context/index';
import { KnowledgeGraphFacade } from './knowledge/index';
import { SemanticIntelligence, semanticGraphSource } from './semantic/index';
import { ResearchService } from './research';
import { HttpResearchBackend } from './research/researchBackends';
import { createResearchTools } from './research/researchTools';
import {
  CachedClassifier,
  createDefaultModelRegistry,
  createRoutingTools,
  getPerformanceTelemetry,
  ModelRouter,
} from './routing';
import { EmergencyStop, SafetyAuditLog, SafetyGate, ScopedPermissionManager, createSafetyTools, type SafetyToolsDeps } from './safety';
import { LongRunManager, createLongRunTools } from './longrun';
import { CapabilityCatalog, createCapabilityTools, SpecialistCatalogSource, PublicApisCatalogSource } from './capabilities';
import { HttpBrowserBackend } from './browser/httpBrowser';
import { createBrowserTools as createBrowserAgentTools } from './browser/browserTools';
import { FilesystemService, ApplicationService } from './system/systemServices';
import { HttpFsBackend, HttpAppBackend } from './system/httpSystem';
import { createSystemTools } from './system/systemTools';
import { DiagnosticsService, createDiagnosticTools } from './diagnostics';
import { createGlobeTools } from './globeTools';

export interface AgentHost {
  applyWebAction(action: import('../types').WebAction): void;
  applyAppAction(action: import('../types').LaptopAppAction): void;
  applyFileAction(action: import('../types').LocalFileAction): void;
  applyMapsAction(action: import('../types').MapsLocationAction): void;
  applyViewerFile(file: import('../utils/fileSystemAccess').LocalIndexedFile): void;
  applyGlobeAction(action: import('../types').GlobeAction): void;
  openModal(modal: import('../types').ActiveModal): void;
  setPose(pose: string): void;
  applyScreenVisionAction?(action: import('../types').ScreenVisionAction): void;
}

export interface AgentSystem {
  core: AgentCore;
  bus: AgentEventBus;
  registry: ToolRegistry;
  /** Permission registry shared by the core and tools (Phase 3). Optional so lightweight test harnesses can omit it. */
  permissions?: PermissionManager;
  /** Screen observation service (Phase 4). */
  screenObserver?: ScreenObserver;
  /** Adaptive observation layer (Phase 13). */
  adaptiveObserver?: AdaptiveObserver;
  /** Keyboard control service (Phase 6). */
  keyboardControl?: KeyboardControlService;
  /** Learning + workflow acquisition service (Phase 12). */
  learning?: LearningService;
  /** Learned Skills v1 — validated reusable-capability engine. */
  skills?: SkillEngine;
  /** Multimodal intelligence service (Phase 14). */
  multimodal?: MultimodalService;
  /** Proactive intelligence service (Phase 15). */
  proactive?: ProactiveService;
  /** Hierarchical planning engine (Phase 16). */
  planning?: PlanEngine;
  /** Context Engine v1 — local-first, cache-first, network-last context selection. */
  contextEngine?: ContextEngine;
  /** Knowledge Graph v1 — bounded relationship store complementing memory. */
  knowledgeGraph?: KnowledgeGraphFacade;
  /** Semantic Intelligence v1 — bounded local semantic expansion layer. */
  semantic?: SemanticIntelligence;
  /** Memory Consolidation v1 — bounded event-driven durable-knowledge engine. */
  consolidation?: ConsolidationEngine;
  /** Deep research intelligence service (additional capability, outside the numbered roadmap). */
  research?: ResearchService;
  /** Model routing (Phase 17) — decision-only router over the model registry. */
  modelRouter?: ModelRouter;
  /** Passive performance telemetry (Phase 17). */
  performance?: ReturnType<typeof getPerformanceTelemetry>;
  /** Safety + permission hardening (Phase 18). */
  safety?: {
    gate: SafetyGate;
    scoped: ScopedPermissionManager;
    audit: SafetyAuditLog;
    emergencyStop: EmergencyStop;
    /** Emergency stop: cancel tasks, revoke temporary grants, block side effects. */
    emergencyStopNow: (reason: string) => void;
    resume: () => void;
  };
  /** Long-run autonomy (Phase 19) — persistent bounded task sessions. */
  longRun?: LongRunManager;
  /** Capability catalog (Phase 20) — lazy metadata-driven discovery. */
  capabilities?: CapabilityCatalog;
  /** Self-Diagnostics v1 — runtime health and failure awareness service. */
  diagnostics?: DiagnosticsService;
  detach: () => void;
}

/** Create the agent system and register the browser-backed tools. */
export function createAgentSystem(host: AgentHost): AgentSystem {
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  const store = new TaskStore();
  const permissions = new PermissionManager();
  permissions.grant('screen.observation');

  // Learning + workflow acquisition (Phase 12): learns from task outcomes and
  // user corrections on the shared event bus; learned workflows are reuse
  // suggestions layered under the existing planner — no second planning loop.
  const learning = new LearningService({
    registry,
    events: bus,
    memory: getMemoryService(),
    taskResolver: (taskId) => store.get(taskId),
  });
  // Advanced planning (Phase 16): hierarchical plan derivation + validation,
  // node lifecycle tracking and BOUNDED replanning. Event-driven and idle
  // between tasks — no polling, no second agent loop; the Agent Core remains
  // the single executor. Memory recall feeds replanning context only.
  const planning = new PlanEngine({
    registry,
    events: bus,
    permissions,
    memory: getMemoryService(),
  });
  // Knowledge Graph v1: bounded relationship store that COMPLEMENTS memory —
  // memory keeps information, the graph keeps how it is connected. Lazy-loaded
  // (no I/O at construction), persisted via the same StorageAdapter
  // convention, deterministic extraction on bus events only.
  const knowledgeGraph = new KnowledgeGraphFacade({ storage: localStorageAdapter });
  // Semantic Intelligence v1: lightweight LOCAL semantic expansion layered
  // UNDER the deterministic relevance stack — exact match first, then
  // bounded alias/graph/learned expansion through the existing Context
  // Engine pipeline. Fully offline by default; the Knowledge Graph acts as
  // one bounded, confidence-filtered expansion source.
  const semantic = new SemanticIntelligence({
    graphSource: semanticGraphSource(knowledgeGraph),
  });
  // Context Engine v1: local-first, cache-first, network-last context
  // selection over the existing memory + task state. Event-driven only
  // (USER_MESSAGE → context package, TASK_COMPLETED → post-result caching),
  // bounded caches, zero new dependencies — it never polls and never
  // replaces the Agent Core or the Phase 2 memory service. The knowledge
  // graph is wired as ONE more targeted source; its statements flow through
  // the existing relevance + budget pipeline like every other source.
  const contextEngine = new ContextEngine({
    memory: getMemoryService(),
    taskStore: store,
    cacheStorage: localStorageAdapter,
    knowledge: { query: (input, limit) => knowledgeGraph.queryStatements(input, limit) },
    semantic,
  });
  // Memory Consolidation v1: bounded, event-driven durable-knowledge engine
  // layered UNDER the existing memory + graph write paths. MemoryService
  // stays the only memory writer (its safety rules remain authoritative);
  // the engine only DECIDES what deserves to persist and observes the same
  // pre-existing bus events as the Knowledge Indexer — no polling.
  const consolidation = new ConsolidationEngine({
    memory: getMemoryService(),
    knowledge: knowledgeGraph.graph,
    semantic,
    storage: localStorageAdapter,
    getTask: (id) => store.get(id),
  });
  // Learned Skills v1: the VALIDATED tier above Phase 12 workflow candidates.
  // Skills are learned only from genuinely verified task executions (honest
  // goal-level verification), validated deterministically, matched through
  // the existing Semantic Intelligence layer, and reused ONLY as normal plans
  // that run through the Agent Core + ToolRegistry + Phase 18 SafetyGate.
  const skills = new SkillEngine({
    registry,
    events: bus,
    storage: localStorageAdapter,
    semantic,
    knowledgeGraph,
    memory: getMemoryService(),
    permissions,
    taskResolver: (taskId) => store.get(taskId),
  });
  const planner = new SkillAwarePlanner(new WorkflowAwarePlanner(new HeuristicPlanner(), learning), skills);
  const core = new AgentCore({
    registry,
    events: bus,
    store,
    permissions,
    planner,
    planning,
    // Intelligence Loop v1: the task consumes the Context Engine package that
    // the USER_MESSAGE listener already built (zero extra computation) — its
    // memories/knowledge are attached to the task before planning, so tools
    // receive relevantMemories and the cycle is traceable end to end.
    contextProvider: (input, taskId) => contextEngine.getTaskContext(taskId) ?? contextEngine.buildContext({ input, taskId, now: Date.now() }),
  });

  registry.registerAll(createBrowserTools());
  registry.registerAll(createGlobeTools());
  // Planner fallback (Phase 1) made real: unclassifiable clauses become
  // system.note steps; system.note is already registered via createBrowserTools() above.

  // Screen vision (Phase 4): native Screen Capture API, gated by the
  // 'screen.observation' permission (default-deny).
  const screenObserver = new ScreenObserver({
    captureSource: new BrowserCaptureSource(),
    events: bus,
    permissions,
  });
  registry.registerAll(createScreenTools(screenObserver));

  // Adaptive observation (Phase 13): event/task-driven scheduling ON TOP of
  // the Phase 4 observer — decides when/how/whether to look at the screen.
  // Budget-bounded, region-aware, no polling loop; respects the same
  // 'screen.observation' permission through the underlying observer.
  const adaptiveObserver = new AdaptiveObserver({ screenObserver, events: bus });

  // Mouse/cursor control (Phase 5): PowerShell backend via the local server,
  // gated by the 'mouse.control' permission (default-deny). Verification
  // flows through the same screen observer.
  const computerControl = new ComputerControlService({
    backend: new PowerShellMouseBackend(),
    observer: screenObserver,
    events: bus,
    permissions,
  });
  registry.registerAll(createMouseTools(computerControl));

  // Keyboard control (Phase 6): PowerShell/SendInput backend via the local
  // server, gated by the 'keyboard.control' permission (default-deny).
  const keyboardControl = new KeyboardControlService({
    backend: new PowerShellKeyboardBackend(),
    observer: screenObserver,
    events: bus,
    permissions,
  });
  registry.registerAll(createKeyboardTools(keyboardControl));

  // Computer-use orchestrator (Phase 7): closed-loop observe/act/verify over
  // the vision + mouse + keyboard services, gated by all three permission
  // domains on the single `computer.use` tool.
  const computerUseAgent = new ComputerUseAgent({
    observer: screenObserver,
    adaptive: adaptiveObserver,
    mouse: computerControl,
    keyboard: keyboardControl,
    events: bus,
  });
  registry.registerAll(createComputerUseTools(computerUseAgent));

  // Browser agent (Phase 8): CDP-controlled browser via the local server,
  // gated by 'browser.interaction'; falls back to the computer-use agent for
  // desktop-level interaction when the controlled browser is unavailable.
  const browserAgent = new BrowserAgent({
    backend: new HttpBrowserBackend(),
    events: bus,
    computerUse: { run: (goal, signal) => computerUseAgent.run(goal, signal) },
    // Phase 13: browser requests screen observation only when useful
    // (after navigation / when CDP state is insufficient). Best-effort.
    adaptiveObservation: {
      observe: (trigger) =>
        adaptiveObserver
          .observe({ trigger: trigger === 'browser_navigation' ? 'browser_navigation' : 'screen_change', priority: 'NORMAL', reason: `browser agent: ${trigger}` })
          .then(() => undefined),
    },
  });
  registry.registerAll(createBrowserAgentTools(browserAgent));

  // Filesystem + application agent (Phase 9): real-disk operations and
  // Windows application control via the local server, permission-gated
  // (filesystem.read granted / filesystem.write default-deny for mutations).
  const filesystemService = new FilesystemService({ fs: new HttpFsBackend(), events: bus });
  const applicationService = new ApplicationService({ fs: new HttpFsBackend(), apps: new HttpAppBackend(), events: bus });
  registry.registerAll(createSystemTools(filesystemService, applicationService));

  // Multimodal intelligence (Phase 14): a task-scoped, bounded evidence
  // context fed by text, Phase 4/13 screen evidence, Phase 8 browser state,
  // Phase 9 application state, and Phase 3 tool results. Purely additive:
  // Agent Core, permissions, recovery, learning safety, and adaptive
  // observation remain authoritative for every decision.
  const multimodal = new MultimodalService(
    { adaptive: adaptiveObserver, browserAgent, applicationService },
    {}
  );
  // Phase 14: CU observations also become multimodal evidence (read-only).
  computerUseAgent.setMultimodal({ recordObservation: (state) => multimodal.context.addInput({ type: 'ui_state', state, source: 'phase7.computerUse' }) });

  // Proactive intelligence (Phase 15): event-driven opportunity detection on
  // the shared bus — SIGNAL → CONTEXT → DECIDE → SAFETY CHECK → OPTIONAL
  // ACTION → VERIFY → MEMORY. No polling; presentation via NOTICE events and
  // the service API; execution only through the existing registry with the
  // authoritative PermissionManager; LEVEL 4 categories never auto-execute.
  const proactive = new ProactiveService({
    registry,
    permissions,
    events: bus,
    memory: getMemoryService(),
    learning,
    multimodalContext: multimodal.context,
  });

  // Deep Research (additional capability, outside the numbered roadmap):
  // bounded multi-step research loops
  // (plan → search → inspect → extract → cross-check → gaps → synthesize)
  // executed THROUGH the ToolRegistry like every other capability. Network
  // access goes through the local server's /api/research/* endpoints; every
  // finding cites inspected sources and low evidence yields an honest
  // low-confidence report instead of manufactured certainty.
  const research = new ResearchService({
    backend: new HttpResearchBackend(),
    registry,
    events: bus,
    permissions,
    multimodal: {
      addText: (text, source) => {
        try {
          multimodal.context.addInput({ type: 'text', text, source });
        } catch {
          // multimodal evidence is best-effort — never blocks research
        }
      },
    },
  });
  registry.registerAll(createResearchTools(research));

  // Safety + permission hardening (Phase 18): the gate is attached to the
  // ToolRegistry — the single chokepoint every execution passes through, from
  // any caller (Agent Core, planning, recovery, proactive, research, tools).
  // Deterministic risk classification; fail-closed on unknown permissions;
  // scoped/expiring/revocable grants layered on the session PermissionManager;
  // bounded redacted audit; emergency stop cancels tasks, revokes temporary
  // grants and blocks new side effects while read-only work continues.
  const safetyAudit = new SafetyAuditLog();
  const scopedPermissions = new ScopedPermissionManager();
  const emergencyStop = new EmergencyStop(safetyAudit);
  const safetyGate = new SafetyGate({
    permissions,
    scoped: scopedPermissions,
    emergencyStop,
    audit: safetyAudit,
  });
  registry.setSafetyGate(safetyGate);
  // Emergency stop reactions (spec §9): cancel active tasks + revoke
  // temporary grants. The gate blocks new side effects while active;
  // read-only work continues; deactivate() fully restores operation.
  emergencyStop.onActivate((reason) => {
    try {
      core.cancelAll();
    } catch {
      // cancellation is best-effort; the gate still blocks side effects
    }
    scopedPermissions.revokeAllTemporary();
    void reason;
  });
  const safetyDeps: SafetyToolsDeps = { gate: safetyGate, scoped: scopedPermissions, audit: safetyAudit, emergencyStop };
  registry.registerAll(createSafetyTools(safetyDeps));
  const safety = {
    gate: safetyGate,
    scoped: scopedPermissions,
    audit: safetyAudit,
    emergencyStop,
    emergencyStopNow: (reason: string) => {
      const result = emergencyStop.activate(reason);
      return result;
    },
    resume: () => emergencyStop.deactivate(),
  };

  // Long-run autonomy (Phase 19): persistent bounded task sessions over the
  // existing core. Fully event-driven (checkpoints at step boundaries — never
  // a persistence loop); single-active-session concurrency; resume is NEVER
  // blind (checkpoint + lifecycle + duplicate-action + budget + emergency
  // stop revalidated first; Phase 18 re-checks every action at execution).
  const longRun = new LongRunManager(core, bus, { audit: safetyAudit });
  longRun.setEmergencyProbe(() => emergencyStop.isActive());
  registry.registerAll(createLongRunTools({
    manager: longRun,
    pollExecutor: async (toolName, input, ctx) =>
      registry.execute(toolName, input, { taskId: ctx.taskId, stepId: ctx.stepId, signal: ctx.signal, memory: {}, permissions }),
  }));

  // Final capability layer (Phase 20): lazy, metadata-driven DISCOVERY over
  // prepared catalogs (krisha-specialists + the supplied public-apis catalog).
  // Advisory only — search/stats never execute anything and never
  // bypass planning, routing, or the Phase 18 gate; executable tools remain
  // exactly the safety-gated ToolRegistry set. Sources load lazily on
  // first search — startup stays free of catalog weight.
  const capabilities = new CapabilityCatalog([new SpecialistCatalogSource(), new PublicApisCatalogSource()]);
  registry.registerAll(createCapabilityTools(capabilities));

  // Model routing (Phase 17): deterministic classification + smallest-capable
  // model selection over the registry of configured models. Decision-only —
  // the tools compute routes and read metrics; they execute nothing, so
  // routing cannot bypass permissions, verification or recovery. Telemetry
  // is passive: it records events that already happened, nothing else.
  const performance = getPerformanceTelemetry();
  const defaultModelRegistry = createDefaultModelRegistry();
  const modelRouter = new ModelRouter(defaultModelRegistry, performance);
  const chatClassifier = new CachedClassifier({ telemetry: performance });
  registry.registerAll(createRoutingTools(modelRouter, chatClassifier, performance));

  // Self-Diagnostics v1: runtime health checks, failure awareness, and verified reporting.
  const diagnostics = new DiagnosticsService({
    core,
    bus,
    registry,
    store,
    storage: localStorageAdapter,
    permissions,
    contextEngine,
    knowledgeGraph,
    semantic,
    memory: getMemoryService(),
    consolidation,
    skills,
    recovery: core.recovery,
    planner,
    router: modelRouter,
    modelRegistry: defaultModelRegistry,
    safetyGate,
    emergencyStop,
  });
  registry.registerAll(createDiagnosticTools(diagnostics));

  // Learned Skills v1 tools: read-only discovery + learned-data management
  // (disable/forget). There is deliberately no "create skill from text" tool —
  // skills come only from verified task executions.
  registry.registerAll(createSkillTools({ skills }));

  // DevTools debug hook for manual verification / later permission UI (no UI surface).
  if (typeof window !== 'undefined') {
    (window as any).__KRISHA_AGENT__ = { core, bus, registry, permissions, screenObserver, adaptiveObserver, computerControl, keyboardControl, computerUseAgent, browserAgent, filesystemService, applicationService, learning, skills, multimodal, proactive, planning, contextEngine, knowledgeGraph, semantic, consolidation, research, modelRouter, performance, safety, longRun, capabilities, diagnostics };
  }

  // Learning + workflow acquisition (Phase 12): subscribe to the shared bus.
  const detachLearning = learning.attach();

  // Learned Skills v1: subscribe to the shared bus (verified-success learning
  // + skill-reuse outcome recording). Event-driven only; never polls.
  const detachSkills = skills.attach();

  // Adaptive observation (Phase 13): event-driven triggers on the shared bus.
  const detachObservation = adaptiveObserver.attach(bus);

  // Multimodal intelligence (Phase 14): task lifecycle + tool results feed
  // the bounded evidence context; purged on task end.
  const detachMultimodal = multimodal.attach(bus);

  // Learned workflows may require fresh screen state for specific steps.
  core.setAdaptiveObserver(adaptiveObserver);

  // Apply declarative UI effects from completed steps onto the existing app state.
  const detachStepListener = bus.on('TASK_STEP_COMPLETED', (event: AgentEvent) => {
    const payload = event.payload as { ui?: UiEffect[] } | undefined;
    const effects = payload?.ui;
    if (!Array.isArray(effects)) return;
    for (const effect of effects) {
      applyEffect(effect, host);
    }
  });

  // Proactive intelligence (Phase 15): event-driven triggers on the shared bus.
  const detachProactive = proactive.attach(bus);

  // Context Engine v1: event-driven context building + post-result caching.
  const detachContext = contextEngine.attach(bus);

  // Knowledge Graph v1: event-driven relationship extraction (decisions,
  // preferences, task results/tools). Bounded per event; never polls.
  const detachKnowledge = knowledgeGraph.attach(bus, { getTask: (id) => store.get(id) });

  // Memory Consolidation v1: event-driven durable-knowledge consolidation
  // (USER_MESSAGE / TASK_COMPLETED). Bounded per event; never polls.
  const detachConsolidation = consolidation.attach(bus);

  // Deep Research (additional capability): task-lifecycle cleanup of research dossiers.
  const detachResearch = research.attach(bus);

  // Long-run autonomy (Phase 19): event-driven session advancement on the bus.
  const detachLongRun = longRun.attach();

  // Self-Diagnostics v1: event-driven failure awareness on the shared bus.
  const detachDiagnostics = diagnostics.attach(bus);

  // Performance telemetry (Phase 17): passive recording of tool durations and
  // task completion times from events that already exist on the bus — no new
  // instrumentation points, no background work. Bounded bookkeeping.
  const perfTaskStarts = new Map<string, number>();
  const detachPerfTool = bus.on('TOOL_COMPLETED', (event) => {
    const payload = event.payload as { tool?: string; durationMs?: number } | undefined;
    if (payload?.tool && typeof payload.durationMs === 'number') performance.recordToolDuration(payload.tool, payload.durationMs);
  });
  const detachPerfTaskStart = bus.on('TASK_STARTED', (event) => {
    if (!event.taskId) return;
    if (perfTaskStarts.size >= 64) perfTaskStarts.delete(perfTaskStarts.keys().next().value as string);
    perfTaskStarts.set(event.taskId, Date.now());
  });
  const detachPerfTaskEnd = bus.on('TASK_COMPLETED', (event) => {
    const startedAt = event.taskId ? perfTaskStarts.get(event.taskId) : undefined;
    if (startedAt !== undefined) {
      performance.recordTaskDuration(Date.now() - startedAt);
      if (event.taskId) perfTaskStarts.delete(event.taskId);
    }
  });
  const detachPerfTaskFail = bus.on('TASK_FAILED', (event) => {
    if (event.taskId) perfTaskStarts.delete(event.taskId);
  });
  const detachPerfTaskCancel = bus.on('TASK_CANCELLED', (event) => {
    if (event.taskId) perfTaskStarts.delete(event.taskId);
  });

  // Screen Vision: surface observed screen state with snapshot and extracted text to the host UI
  const detachScreenObserved = bus.on('SCREEN_OBSERVED', (event) => {
    const payload = event.payload as any;
    const state = payload?.state;
    if (state && host.applyScreenVisionAction) {
      const snapshotUrl = state.snapshotRef ? screenObserver.getSnapshot(state.snapshotRef) : undefined;
      host.applyScreenVisionAction({
        type: 'observe',
        summary: state.analysis.summary,
        application: state.analysis.application || state.activeWindow?.title || 'Desktop / Browser Screen',
        activeWindowTitle: state.activeWindow?.title,
        textSummary: state.analysis.texts?.map((t: any) => t.text).filter(Boolean).join(' • '),
        texts: state.analysis.texts || [],
        elements: state.analysis.elements || [],
        dialogs: state.analysis.dialogs,
        errors: state.analysis.errors,
        warnings: state.analysis.warnings,
        snapshotUrl,
        timestamp: state.timestamp,
      });
    }
  });

  return {
    core,
    bus,
    registry,
    permissions,
    screenObserver,
    adaptiveObserver,
    keyboardControl,
    learning,
    skills,
    multimodal,
    proactive,
    planning,
    contextEngine,
    knowledgeGraph,
    semantic,
    consolidation,
    research,
    modelRouter,
    performance,
    safety,
    longRun,
    capabilities,
    diagnostics,
    detach: () => {
      detachStepListener();
      detachLearning();
      detachSkills();
      detachObservation();
      detachMultimodal();
      detachProactive();
      detachContext();
      detachKnowledge();
      detachConsolidation();
      detachResearch();
      detachLongRun();
      detachDiagnostics();
      detachPerfTool();
      detachPerfTaskStart();
      detachPerfTaskEnd();
      detachPerfTaskFail();
      detachPerfTaskCancel();
      detachScreenObserved();
    },
  };
}

function applyEffect(effect: UiEffect, host: AgentHost): void {
  switch (effect.kind) {
    case 'web_action':
      host.applyWebAction(effect.action);
      break;
    case 'app_action':
      host.applyAppAction(effect.action);
      break;
    case 'file_action':
      host.applyFileAction(effect.action);
      break;
    case 'maps_action':
      host.applyMapsAction(effect.action);
      break;
    case 'viewer_file':
      host.applyViewerFile(effect.file);
      break;
    case 'open_modal':
      host.openModal(effect.modal);
      break;
    case 'globe_action':
      host.applyGlobeAction(effect.action);
      break;
    case 'pose':
      host.setPose(effect.pose);
      break;
  }
}

export interface AgentRunResult {
  task: AgentTask;
  summary: string;
}

/** Run a delegated multi-step task and resolve with its honest summary. */
export async function runAgentTask(system: AgentSystem, text: string): Promise<AgentRunResult> {
  const task = await system.core.submit(text);
  return { task, summary: task.summary || '' };
}

export { isMultiStepRequest, isScreenIntent, isMouseIntent, isKeyboardIntent, isSystemIntent, isResearchIntent };
