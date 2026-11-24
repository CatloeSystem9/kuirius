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
  type: 'notify' | 'suggest_proactive' | 'execute_task';
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
  data: Record<string, unknown>;
  title: string;
  message: string;
  timestamp: number;
}

export interface EventTriggerEngineOptions {
  storagePath?: string;
  downloadsDir?: string;
  enableDownloadsWatcher?: boolean;
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
  }

  /**
   * Feed a process event from ProcessMonitor into the reactive engine
   */
  public handleProcessEvent(event: ProcessEvent): void {
    const eventType: EventTriggerType =
      event.kind === 'process_created' ? 'process_started' : 'process_terminated';

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
        commandLine: event.commandLine,
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

    // Render message from template
    let message = rule.action.messageTemplate;
    for (const [key, val] of Object.entries(data)) {
      message = message.replace(new RegExp(`\\{${key}\\}`, 'g'), String(val));
    }

    const payload: TriggeredEventPayload = {
      ruleId: rule.id,
      source: rule.source,
      eventType: rule.eventType,
      data,
      title: rule.action.title,
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
    const fullRule: ReactiveRule = {
      ...rule,
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
          type: 'suggest_proactive',
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
          processNamePattern: 'code',
        },
        action: {
          type: 'suggest_proactive',
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
          if (r && typeof r.id === 'string') {
            this.rules.set(r.id, r);
          }
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
