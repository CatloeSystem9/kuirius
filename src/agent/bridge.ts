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
import { TaskStore } from './taskState';
import { AgentCore } from './agentCore';
import { PermissionManager } from './permissions';
import { createBrowserTools } from './browserTools';
import { createScreenTools } from './vision/screenTools';
import { ScreenObserver } from './vision/screenObserver';
import { BrowserCaptureSource } from './vision/browserCapture';
import { isMultiStepRequest, isScreenIntent, isMouseIntent, isKeyboardIntent, isSystemIntent, HeuristicPlanner } from './planner';
import { LearningService } from './learning/learningService';
import { WorkflowAwarePlanner } from './learning/workflowPlanner';
import { getMemoryService } from './memory/memoryService';
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
import { HttpBrowserBackend } from './browser/httpBrowser';
import { createBrowserTools as createBrowserAgentTools } from './browser/browserTools';
import { FilesystemService, ApplicationService } from './system/systemServices';
import { HttpFsBackend, HttpAppBackend } from './system/httpSystem';
import { createSystemTools } from './system/systemTools';

export interface AgentHost {
  applyWebAction(action: import('../types').WebAction): void;
  applyAppAction(action: import('../types').LaptopAppAction): void;
  applyFileAction(action: import('../types').LocalFileAction): void;
  applyMapsAction(action: import('../types').MapsLocationAction): void;
  applyViewerFile(file: import('../utils/fileSystemAccess').LocalIndexedFile): void;
  openModal(modal: import('../types').ActiveModal): void;
  setPose(pose: string): void;
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
  /** Multimodal intelligence service (Phase 14). */
  multimodal?: MultimodalService;
  detach: () => void;
}

/** Create the agent system and register the browser-backed tools. */
export function createAgentSystem(host: AgentHost): AgentSystem {
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  const store = new TaskStore();
  const permissions = new PermissionManager();

  // Learning + workflow acquisition (Phase 12): learns from task outcomes and
  // user corrections on the shared event bus; learned workflows are reuse
  // suggestions layered under the existing planner — no second planning loop.
  const learning = new LearningService({
    registry,
    events: bus,
    memory: getMemoryService(),
    taskResolver: (taskId) => store.get(taskId),
  });
  const core = new AgentCore({
    registry,
    events: bus,
    store,
    permissions,
    planner: new WorkflowAwarePlanner(new HeuristicPlanner(), learning),
  });

  registry.registerAll(createBrowserTools());

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

  // DevTools debug hook for manual verification / later permission UI (no UI surface).
  if (typeof window !== 'undefined') {
    (window as any).__KRISHA_AGENT__ = { core, bus, registry, permissions, screenObserver, adaptiveObserver, computerControl, keyboardControl, computerUseAgent, browserAgent, filesystemService, applicationService, learning, multimodal };
  }

  // Learning + workflow acquisition (Phase 12): subscribe to the shared bus.
  const detachLearning = learning.attach();

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

  return {
    core,
    bus,
    registry,
    permissions,
    screenObserver,
    adaptiveObserver,
    keyboardControl,
    learning,
    multimodal,
    detach: () => {
      detachStepListener();
      detachLearning();
      detachObservation();
      detachMultimodal();
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

export { isMultiStepRequest, isScreenIntent, isMouseIntent, isKeyboardIntent, isSystemIntent };
