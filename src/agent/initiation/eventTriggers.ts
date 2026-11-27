/**
 * Reactive Event Triggers Engine (Initiation Subsystem)
 * 
 * Subscribes to telemetry from:
 * - Process Monitor (process_started, process_terminated)
 * - Finished Downloads Watcher (Downloads directory completed files)
 * - File system watchers (created, modified)
 * - Clipboard change signals
 * 
 * Applies reactive rules with debouncing, cooldowns, and tranquility filters
 * to autonomously initiate appropriate assistant suggestions and tasks.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ProcessEvent } from '../processmonitor/monitorTypes';
import type { InitiationAction } from './contracts';
import { FileChangeWatcher, type FileChangeEvent } from './fileWatcher';

export type EventSource = 'process' | 'download' | 'file' | 'clipboard';

export type EventTriggerType =
  | 'process_started'
  | 'process_terminated'
  | 'download_completed'
  | 'file_created'
  | 'file_modified'
  | 'clipboard_text';

export interface ReactiveRuleFilter {
  processNamePattern?: string; // e.g. "Code.exe", "blender"
  fileExtension?: string; // e.g. ".pdf", ".zip"
  pathPattern?: string;
  minFileSize?: number;
}

export interface ReactiveRuleAction {
  type: InitiationAction;
  title: string;
  messageTemplate: string; // e.g. "Finished download: {filename}"
  taskPrompt?: string;
  payload?: Record<string, unknown>;
}

export interface ReactiveRule {
  id: string;
  name: string;
  description: string;
  source: EventSource;
  eventType: EventTriggerType;
  filter?: ReactiveRuleFilter;
  action: ReactiveRuleAction;
  cooldownMs: number; // minimum time between triggers (ms)
  lastFiredAt?: number;
  fireCount: number;
  enabled: boolean;
}

export interface TriggeredEventPayload {
  ruleId: string;
  source: EventSource;
  eventType: EventTriggerType;
  /** What the executor should do with this event. */
  action: InitiationAction;
  /** The task to run when `action` is `execute_task`. */
  taskPrompt?: string;
  data: Record<string, unknown>;
  title: string;
  message: string;
  timestamp: number;
}

export interface EventTriggerEngineOptions {
  storagePath?: string;
  downloadsDir?: string;
  enableDownloadsWatcher?: boolean;
  /** Directories to watch for file_created / file_modified events. */
  watchDirectories?: string[];
  enableFileWatcher?: boolean;
  onRuleFired?: (event: TriggeredEventPayload) => Promise<void> | void;
  audit?: (event: { kind: string; ruleId?: string; [key: string]: unknown }) => void;
  now?: () => number;
}

const DEFAULT_STORE_DIR = path.join(process.cwd(), '.krisha');
const DEFAULT_RULES_FILE = 'reactive_rules.json';

export class EventTriggerEngine {
  private rules = new Map<string, ReactiveRule>();
  private readonly storagePath: string;
  private readonly downloadsDir: string;
  private readonly onRuleFired?: (event: TriggeredEventPayload) => Promise<void> | void;
  private readonly audit?: (event: { kind: string; ruleId?: string; [key: string]: unknown }) => void;
  private readonly now: () => number;

  private downloadsWatcher: fs.FSWatcher | null = null;
  private knownDownloadFiles = new Set<string>();
  private pendingDownloads = new Map<string, number>(); // partial files being tracked
  private fileWatcher: FileChangeWatcher | null = null;

  constructor(options: EventTriggerEngineOptions = {}) {
    this.storagePath = options.storagePath || path.join(DEFAULT_STORE_DIR, DEFAULT_RULES_FILE);
    this.downloadsDir = options.downloadsDir || path.join(os.homedir(), 'Downloads');
    this.onRuleFired = options.onRuleFired;
    this.audit = options.audit;
    this.now = options.now || (() => Date.now());

    this.loadRules();
    this.ensureDefaultRules();

    if (options.enableDownloadsWatcher !== false) {
      this.startDownloadsWatcher();
    }

    if (options.enableFileWatcher !== false && (options.watchDirectories?.length ?? 0) > 0) {
      this.startFileWatcher(options.watchDirectories || []);
    }
  }

  /**
   * Start watching approved directories for file changes.
   */
  public startFileWatcher(directories: string[]): void {
    if (!directories.length) return;
    this.fileWatcher?.stop();
    this.fileWatcher = new FileChangeWatcher({
      directories,
      onEvent: (event) => this.handleFileChange(event),
    });
    this.fileWatcher.start();
  }

  /** Stop the file watcher. */
  public stopFileWatcher(): void {
    this.fileWatcher?.stop();
    this.fileWatcher = null;
  }

  /** The directories currently watched for file changes. */
  public getWatchedDirectories(): string[] {
    return this.fileWatcher?.getWatchedDirectories() ?? [];
  }

  /**
   * A file appeared or changed in a watched directory.
   */
  public handleFileChange(event: FileChangeEvent): void {
    const eventType: EventTriggerType = event.kind === 'file_created' ? 'file_created' : 'file_modified';

    for (const rule of this.rules.values()) {
      if (!rule.enabled || rule.source !== 'file' || rule.eventType !== eventType) continue;

      if (rule.filter?.fileExtension) {
        const reqExt = rule.filter.fileExtension.toLowerCase();
        const ext = event.extension.toLowerCase();
        if (ext !== reqExt && !ext.endsWith(reqExt)) continue;
      }

      if (rule.filter?.pathPattern && !event.path.toLowerCase().includes(rule.filter.pathPattern.toLowerCase())) {
        continue;
      }

      if (rule.filter?.minFileSize && event.size < rule.filter.minFileSize) continue;

      this.evaluateAndFireRule(rule, {
        filename: event.filename,
        path: event.path,
        size: event.size,
        extension: event.extension,
        dir: event.dir,
      });
    }
  }

  /**
   * The clipboard CHANGED.
   *
   * Deliberately content-free: the Windows layer reports that the clipboard
   * sequence number moved (a Win32 counter that needs no clipboard read), so
   * Krisha learns that "something was copied" without ever reading what.
   */
  public handleClipboardChanged(): void {
    for (const rule of this.rules.values()) {
      if (!rule.enabled || rule.source !== 'clipboard' || rule.eventType !== 'clipboard_text') continue;
      this.evaluateAndFireRule(rule, { changed: true });
    }
  }

  /**
   * Feed a process event from ProcessMonitor into the reactive engine
   */
  public handleProcessEvent(event: ProcessEvent): void {
    // The monitor emits 'create' / 'delete' — NOT 'process_created'.
    const eventType: EventTriggerType = event.kind === 'create' ? 'process_started' : 'process_terminated';

    const pName = (event.name || '').toLowerCase();

    for (const rule of this.rules.values()) {
      if (!rule.enabled || rule.source !== 'process' || rule.eventType !== eventType) continue;

      if (rule.filter?.processNamePattern) {
        const pattern = rule.filter.processNamePattern.toLowerCase();
        if (!pName.includes(pattern)) continue;
      }

      this.evaluateAndFireRule(rule, {
        processName: event.name,
        pid: event.pid,
        // The monitor is metadata-only — there is no command line to report.
        ...(event.kind === 'create' && event.path ? { path: event.path } : {}),
      });
    }
  }

  /**
   * Feed a finished download event into the reactive engine
   */
  public handleDownloadCompleted(fileInfo: {
    filename: string;
    fullPath: string;
    size: number;
    extension: string;
  }): void {
    const ext = fileInfo.extension.toLowerCase();

    for (const rule of this.rules.values()) {
      if (!rule.enabled || rule.source !== 'download' || rule.eventType !== 'download_completed') continue;

      if (rule.filter?.fileExtension) {
        const reqExt = rule.filter.fileExtension.toLowerCase();
        if (ext !== reqExt && !ext.endsWith(reqExt)) continue;
      }

      if (rule.filter?.minFileSize && fileInfo.size < rule.filter.minFileSize) continue;

      this.evaluateAndFireRule(rule, {
        filename: fileInfo.filename,
        path: fileInfo.fullPath,
        size: fileInfo.size,
        extension: fileInfo.extension,
      });
    }
  }

  /**
   * Feed arbitrary custom file or clipboard events
   */
  public handleCustomEvent(
    source: EventSource,
    eventType: EventTriggerType,
    data: Record<string, unknown>
  ): void {
    for (const rule of this.rules.values()) {
      if (!rule.enabled || rule.source !== source || rule.eventType !== eventType) continue;
      this.evaluateAndFireRule(rule, data);
    }
  }

  /**
   * Start watching the user's Downloads directory for completed downloads
   */
  public startDownloadsWatcher(): void {
    if (this.downloadsWatcher || !fs.existsSync(this.downloadsDir)) return;

    try {
      // Snapshot initial existing files
      const existing = fs.readdirSync(this.downloadsDir);
      for (const f of existing) {
        this.knownDownloadFiles.add(f);
      }

      this.downloadsWatcher = fs.watch(this.downloadsDir, (eventType, filename) => {
        if (!filename) return;
        this.onDownloadsDirChange(filename);
      });

      // Unref watcher so it doesn't block clean process shutdown
      (this.downloadsWatcher as any)?.unref?.();
    } catch (err) {
      console.warn('[EventTrigger] Could not initialize Downloads directory watcher:', err);
    }
  }

  /**
   * Stop watching the Downloads directory
   */
  public stopDownloadsWatcher(): void {
    if (this.downloadsWatcher) {
      try {
        this.downloadsWatcher.close();
      } catch {}
      this.downloadsWatcher = null;
    }
  }

  /**
   * Evaluate a rule against cooldown and fire action if eligible
   */
  private evaluateAndFireRule(rule: ReactiveRule, data: Record<string, unknown>): boolean {
    const now = this.now();

    // Cooldown check
    if (rule.lastFiredAt && now - rule.lastFiredAt < rule.cooldownMs) {
      return false; // Still in cooldown
    }

    rule.lastFiredAt = now;
    rule.fireCount = (rule.fireCount || 0) + 1;
    this.saveRules();

    // Render message (and task prompt) from the template placeholders.
    const render = (template: string): string => {
      let out = template;
      for (const [key, val] of Object.entries(data)) {
        out = out.replace(new RegExp(`\\{${key}\\}`, 'g'), String(val));
      }
      return out;
    };
    const message = render(rule.action?.messageTemplate || '');
    const taskPrompt = rule.action?.taskPrompt ? render(rule.action.taskPrompt) : undefined;

    const payload: TriggeredEventPayload = {
      ruleId: rule.id,
      source: rule.source,
      eventType: rule.eventType,
      action: rule.action?.type || 'notify',
      ...(rule.action?.taskPrompt ? { taskPrompt: rule.action.taskPrompt } : {}),
      data,
      title: rule.action?.title || 'Krisha noticed something',
      message,
      timestamp: now,
    };

    this.audit?.({
      kind: 'reactive_rule_fired',
      ruleId: rule.id,
      eventType: rule.eventType,
      title: rule.action.title,
    });

    try {
      this.onRuleFired?.(payload);
    } catch (err) {
      console.warn(`[EventTrigger] Error executing action for rule ${rule.id}:`, err);
    }

    return true;
  }

  /**
   * Handle file system change in Downloads folder
   */
  private onDownloadsDirChange(filename: string): void {
    const fullPath = path.join(this.downloadsDir, filename);

    // Filter out temporary partial download suffixes from Chrome, Edge, Firefox, Opera
    const isPartial =
      filename.endsWith('.crdownload') ||
      filename.endsWith('.tmp') ||
      filename.endsWith('.part') ||
      filename.endsWith('.opdownload') ||
      filename.startsWith('~$');

    if (isPartial) {
      this.pendingDownloads.set(filename, this.now());
      return;
    }

    // If it's a finished file that wasn't previously known
    setTimeout(() => {
      try {
        if (!fs.existsSync(fullPath)) return;
        const stat = fs.statSync(fullPath);
        if (!stat.isFile() || stat.size === 0) return;

        if (!this.knownDownloadFiles.has(filename)) {
          this.knownDownloadFiles.add(filename);

          const ext = path.extname(filename);
          this.handleDownloadCompleted({
            filename,
            fullPath,
            size: stat.size,
            extension: ext,
          });
        }
      } catch {
        // file might be locked or transient
      }
    }, 500);
  }

  /**
   * Get all reactive rules
   */
  public getRules(): ReactiveRule[] {
    return Array.from(this.rules.values());
  }

  /**
   * Add a new reactive rule
   */
  public addRule(rule: Omit<ReactiveRule, 'fireCount'>): ReactiveRule {
    const actionType = rule.action?.type;
    const action: InitiationAction =
      actionType === 'notify' || actionType === 'suggest' || actionType === 'execute_task'
        ? actionType
        : actionType === 'suggest_proactive'
          ? 'suggest'
          : 'notify';
    const fullRule: ReactiveRule = {
      ...rule,
      action: { ...(rule.action || { title: 'Krisha noticed something', messageTemplate: '' }), type: action },
      fireCount: 0,
    };
    this.rules.set(fullRule.id, fullRule);
    this.saveRules();
    return fullRule;
  }

  /**
   * Toggle a rule on/off
   */
  public toggleRule(id: string, enabled?: boolean): boolean {
    const rule = this.rules.get(id);
    if (!rule) return false;
    rule.enabled = enabled !== undefined ? enabled : !rule.enabled;
    this.saveRules();
    return rule.enabled;
  }

  /**
   * Delete a rule
   */
  public removeRule(id: string): boolean {
    const res = this.rules.delete(id);
    if (res) this.saveRules();
    return res;
  }

  /**
   * Populate default rules if none exist
   */
  private ensureDefaultRules(): void {
    // 1. Download finished notification & organize rule
    if (!this.rules.has('rule_download_completed')) {
      this.rules.set('rule_download_completed', {
        id: 'rule_download_completed',
        name: 'Download Completed Notification',
        description: 'Notifies when a new file finishes downloading to Downloads folder.',
        source: 'download',
        eventType: 'download_completed',
        action: {
          type: 'suggest',
          title: 'Download Completed',
          messageTemplate: 'New file downloaded: "{filename}". Would you like to inspect or organize it?',
          taskPrompt: 'Inspect and organize downloaded file {filename}',
        },
        cooldownMs: 60_000, // 1 min cooldown
        fireCount: 0,
        enabled: true,
      });
    }

    // 2. VS Code IDE Launched
    if (!this.rules.has('rule_vscode_opened')) {
      this.rules.set('rule_vscode_opened', {
        id: 'rule_vscode_opened',
        name: 'VS Code Workflow Assistant',
        description: 'Detects when VS Code launches and offers project goal assistance.',
        source: 'process',
        eventType: 'process_started',
        filter: {
          processNamePattern: 'code.exe',
        },
        action: {
          type: 'suggest',
          title: 'Development Workspace Detected',
          messageTemplate: 'VS Code is open! Ready to assist with active code goals and documentation.',
        },
        cooldownMs: 15 * 60_000, // 15 min cooldown
        fireCount: 0,
        enabled: true,
      });
    }

    // 3. Windows Terminal / CMD Launched
    if (!this.rules.has('rule_terminal_opened')) {
      this.rules.set('rule_terminal_opened', {
        id: 'rule_terminal_opened',
        name: 'Terminal Session Assistant',
        description: 'Detects when Windows Terminal or CMD opens.',
        source: 'process',
        eventType: 'process_started',
        filter: {
          processNamePattern: 'wt.exe',
        },
        action: {
          type: 'notify',
          title: 'Terminal Active',
          messageTemplate: 'Command line terminal opened. Need assistance with any shell commands?',
        },
        cooldownMs: 20 * 60_000, // 20 min cooldown
        fireCount: 0,
        enabled: true,
      });
    }

    // 4. A new file appeared in a watched (approved) directory.
    if (!this.rules.has('rule_file_created')) {
      this.rules.set('rule_file_created', {
        id: 'rule_file_created',
        name: 'New File In Project',
        description: 'Detects a new file appearing in an approved project directory.',
        source: 'file',
        eventType: 'file_created',
        action: {
          type: 'suggest',
          title: 'New File Detected',
          messageTemplate: 'New file appeared: "{filename}". Want me to take a look?',
          taskPrompt: 'A new file appeared in the project: {filename}. Say what it is and whether it matters.',
        },
        cooldownMs: 30 * 60_000, // 30 min cooldown
        fireCount: 0,
        enabled: true,
      });
    }

    this.saveRules();
  }

  /**
   * Load rules from disk
   */
  private loadRules(): void {
    try {
      if (!fs.existsSync(this.storagePath)) return;
      const raw = fs.readFileSync(this.storagePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const r of parsed) {
          if (!r || typeof r.id !== 'string') continue;
          // Repair: rules persisted before the action contract existed (or
          // with the old 'suggest_proactive' name) get a valid action.
          const actionType = r.action?.type;
          const action: InitiationAction =
            actionType === 'notify' || actionType === 'suggest' || actionType === 'execute_task'
              ? actionType
              : actionType === 'suggest_proactive'
                ? 'suggest'
                : 'notify';
          this.rules.set(r.id, {
            ...r,
            action: { ...(r.action || {}), type: action },
            cooldownMs: typeof r.cooldownMs === 'number' ? r.cooldownMs : 60_000,
            fireCount: typeof r.fireCount === 'number' ? r.fireCount : 0,
            enabled: r.enabled !== false,
          });
        }
      }
    } catch (err) {
      console.warn('[EventTrigger] Could not load persisted reactive rules:', err);
    }
  }

  /**
   * Save rules to disk
   */
  private saveRules(): void {
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.storagePath, JSON.stringify(Array.from(this.rules.values()), null, 2), 'utf8');
    } catch (err) {
      console.warn('[EventTrigger] Could not save reactive rules to disk:', err);
    }
  }
}
