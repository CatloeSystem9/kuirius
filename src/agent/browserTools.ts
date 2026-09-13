/**
 * Browser-backed tool implementations (Phase 3 contract).
 *
 * Each tool declares the full standard contract: capabilities, permissions,
 * input schema, risk level, cost, timeout, retry policy, and a verification
 * strategy. Execute bodies preserve the Phase 1 behavior exactly — only the
 * declarative contract around them is new.
 *
 * Nothing here is imported by the core or by tests with browser APIs —
 * registered at runtime from App.tsx (tests may register them with an
 * injected MemoryService for the memory tools).
 */
import type { AgentTool, ToolResult } from './types';
import { ok, fail } from './types';
import type { WebAction, LaptopAppAction, LocalFileAction, MapsLocationAction } from '../types';
import type { LocalIndexedFile } from '../utils/fileSystemAccess';
import type { LaptopApp } from '../utils/appLauncher';
import { openExternalUrl } from '../utils/webActions';
import { launchLaptopApp, searchLaptopApps } from '../utils/appLauncher';
import { loadIndexedFiles, searchLocalFiles, openOrDownloadFile } from '../utils/fileSystemAccess';
import { acquireLocationWithPriority, shouldOpenGoogleMaps, buildMapsActionFromLocation } from '../utils/locationService';
import type { MemoryService } from './memory/memoryService';
import { getMemoryService } from './memory/memoryService';

const BROWSER_VERIFICATION = {
  strategy: 'self_reported' as const,
  description:
    'Reports whether the browser accepted the navigation dispatch. Confirming the rendered page state requires screen observation (Phase 4+).',
};

const APP_VERIFICATION = {
  strategy: 'self_reported' as const,
  description:
    'Reports that the OS protocol dispatch was accepted by the browser; whether the OS actually started the application is not verifiable until Phase 4+ screen observation.',
};

function pose() {
  return { kind: 'pose' as const, pose: 'waving_greeting' };
}

function toFileActionShape(file: LocalIndexedFile): NonNullable<LocalFileAction['matchedFiles']>[number] {
  return {
    id: file.id,
    name: file.name,
    folderName: file.folderName,
    folderPath: file.folderPath,
    size: file.size,
    extension: file.extension,
    category: file.category,
    blobUrl: file.blobUrl,
  };
}

function toViewerFile(file: LocalIndexedFile): LocalIndexedFile {
  return { ...file };
}

/** Shared helpers used by the file tools. */
async function searchFiles(query: string, folderName: string): Promise<{ matched: LocalIndexedFile[]; action: LocalFileAction }> {
  const { files } = await loadIndexedFiles();
  const matched = searchLocalFiles(query, folderName && folderName !== 'ALL' ? folderName : undefined, files);
  const action: LocalFileAction = {
    type: 'search_file',
    query,
    folderName: folderName || undefined,
    matchedFiles: matched.slice(0, 50).map(toFileActionShape),
  };
  return { matched, action };
}

export function createBrowserTools(memory: MemoryService = getMemoryService()): AgentTool[] {
  const tools: AgentTool[] = [
    {
      name: 'web.open_website',
      description: 'Open a website in a new browser tab (known platforms or direct URLs).',
      category: 'web',
      riskLevel: 'safe',
      cost: 'cheap',
      reliability: 0.7,
      capabilities: ['browser.open_url', 'browser.navigate'],
      permissions: ['browser.interaction'],
      inputSchema: { required: ['action'], types: { action: 'object' } },
      verification: BROWSER_VERIFICATION,
      timeoutMs: 8000,
      retryPolicy: { maxAttempts: 2 },
      async execute(input): Promise<ToolResult> {
        const action = input.action as WebAction | undefined;
        if (!action?.url) return fail('web.open_website requires input.action.url');
        const opened = openExternalUrl(action.url);
        if (!opened.success) return fail('The browser blocked opening a new tab', { retryable: true, ui: [{ kind: 'web_action', action }] });
        return ok({
          output: { opened: true, url: action.url, siteName: action.siteName },
          state: { lastUrl: action.url },
          ui: [{ kind: 'web_action', action }, pose()],
        });
      },
    },
    {
      name: 'web.search_website',
      description: 'Search within a website (YouTube, Google, Spotify, ...) by opening its search URL.',
      category: 'web',
      riskLevel: 'safe',
      cost: 'cheap',
      reliability: 0.7,
      capabilities: ['browser.search', 'browser.open_url'],
      permissions: ['browser.interaction'],
      inputSchema: { required: ['action'], types: { action: 'object' } },
      verification: BROWSER_VERIFICATION,
      timeoutMs: 8000,
      retryPolicy: { maxAttempts: 2 },
      async execute(input): Promise<ToolResult> {
        const action = input.action as WebAction | undefined;
        if (!action?.url) return fail('web.search_website requires input.action.url');
        const opened = openExternalUrl(action.url);
        if (!opened.success) return fail('The browser blocked opening a new tab', { retryable: true, ui: [{ kind: 'web_action', action }] });
        return ok({
          output: { opened: true, url: action.url, siteName: action.siteName, query: action.query ?? '' },
          state: { lastUrl: action.url },
          ui: [{ kind: 'web_action', action }, pose()],
        });
      },
    },
    {
      name: 'app.launch',
      description: 'Launch an installed laptop/desktop application through its OS protocol scheme.',
      category: 'applications',
      riskLevel: 'medium',
      cost: 'cheap',
      reliability: 0.6,
      capabilities: ['application.launch'],
      permissions: ['application.launch'],
      inputSchema: { required: ['app'], types: { app: 'object' } },
      verification: APP_VERIFICATION,
      timeoutMs: 8000,
      async execute(input): Promise<ToolResult> {
        const app = input.app as LaptopApp | undefined;
        if (!app?.protocol) return fail('app.launch requires input.app');
        const launch = launchLaptopApp(app);
        const appAction: LaptopAppAction = {
          type: 'launch_app',
          appName: app.name,
          protocol: app.protocol,
          fallbackUrl: app.fallbackUrl,
          category: app.category,
          description: app.description,
        };
        if (!launch.success) {
          return fail(`Could not launch ${app.name} (protocol ${app.protocol} not handled)`, {
            retryable: false,
            ui: [{ kind: 'app_action', action: appAction }],
          });
        }
        // Honest note: protocol dispatch accepted by the browser does not prove the OS started the app.
        return ok({
          output: { launched: true, method: launch.method, app: app.name, verified: false },
          state: { lastLaunchedApp: app.name },
          ui: [{ kind: 'app_action', action: appAction }, pose()],
        });
      },
    },
    {
      name: 'app.list',
      description: 'List registered laptop applications, optionally filtered by a search query.',
      category: 'applications',
      riskLevel: 'safe',
      cost: 'free',
      reliability: 1.0,
      capabilities: ['application.list'],
      permissions: [],
      inputSchema: { optional: ['query'], types: { query: 'string' } },
      verification: { strategy: 'self_reported', description: 'List is computed locally from the registered app catalog.' },
      timeoutMs: 5000,
      async execute(input): Promise<ToolResult> {
        const query = typeof input.query === 'string' ? input.query : '';
        const apps = searchLaptopApps(query);
        const appAction: LaptopAppAction = { type: 'list_apps', appName: 'Downloaded Laptop Apps' };
        return ok({
          output: { count: apps.length, names: apps.slice(0, 20).map((a) => a.name) },
          ui: [{ kind: 'app_action', action: appAction }, { kind: 'open_modal', modal: 'apps' }],
        });
      },
    },
    {
      name: 'files.search',
      description: 'Search the indexed local files by name, folder, extension, or text content.',
      category: 'filesystem',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.9,
      capabilities: ['filesystem.search'],
      permissions: ['filesystem.read'],
      inputSchema: { optional: ['query', 'folderName'], types: { query: 'string', folderName: 'string' } },
      verification: { strategy: 'self_reported', description: 'Reports match count and file names from the local index.' },
      timeoutMs: 10000,
      async execute(input): Promise<ToolResult> {
        const query = typeof input.query === 'string' ? input.query : '';
        const folderName = typeof input.folderName === 'string' ? input.folderName : '';
        const { matched, action } = await searchFiles(query, folderName);
        return ok({
          output: { count: matched.length, names: matched.slice(0, 10).map((f) => f.name) },
          state: { lastFileSearch: { query, count: matched.length } },
          ui: [{ kind: 'file_action', action }],
        });
      },
    },
    {
      name: 'files.open',
      description: 'Find files matching a query and open the best match in the document viewer / a new tab.',
      category: 'filesystem',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.85,
      capabilities: ['filesystem.open', 'filesystem.search'],
      permissions: ['filesystem.read'],
      inputSchema: { optional: ['query', 'folderName'], types: { query: 'string', folderName: 'string' } },
      verification: {
        strategy: 'self_reported',
        description: 'Reports the file that was opened; rendering confirmation appears in the viewer modal.',
      },
      timeoutMs: 10000,
      async execute(input): Promise<ToolResult> {
        const query = typeof input.query === 'string' ? input.query : '';
        const folderName = typeof input.folderName === 'string' ? input.folderName : '';
        const { matched, action } = await searchFiles(query, folderName);
        action.type = 'open_file';

        if (matched.length === 0) {
          return fail(`No indexed files matched "${query || 'the given query'}"`, {
            retryable: false,
            errorKind: 'not_found',
            ui: [{ kind: 'file_action', action }, { kind: 'open_modal', modal: 'files' }],
          });
        }

        const target = matched[0];
        openOrDownloadFile(target);
        return ok({
          output: { opened: target.name, totalMatches: matched.length },
          state: { lastOpenedFile: target.name },
          ui: [
            { kind: 'file_action', action },
            { kind: 'viewer_file', file: toViewerFile(target) },
            { kind: 'open_modal', modal: 'file_viewer' },
            pose(),
          ],
        });
      },
    },
    {
      name: 'files.scan',
      description: 'Scan/search indexed folders and report what is inside them.',
      category: 'filesystem',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.9,
      capabilities: ['filesystem.scan', 'filesystem.search'],
      permissions: ['filesystem.read'],
      inputSchema: { optional: ['query', 'folderName'], types: { query: 'string', folderName: 'string' } },
      verification: { strategy: 'self_reported', description: 'Reports folder contents from the local index.' },
      timeoutMs: 10000,
      async execute(input): Promise<ToolResult> {
        const query = typeof input.query === 'string' ? input.query : '';
        const folderName = typeof input.folderName === 'string' ? input.folderName : '';
        const { matched, action } = await searchFiles(query, folderName);
        action.type = 'scan_folder';
        return ok({
          output: { count: matched.length, folderName: folderName || 'ALL', names: matched.slice(0, 10).map((f) => f.name) },
          ui: [{ kind: 'file_action', action }, { kind: 'open_modal', modal: 'files' }],
        });
      },
    },
    {
      name: 'location.get',
      description: "Check the user's current location (GPS first, geocoder fallback) and pin it on a map card.",
      category: 'location',
      riskLevel: 'low',
      cost: 'moderate',
      reliability: 0.75,
      capabilities: ['location.current'],
      permissions: ['location.access'],
      inputSchema: { optional: ['text'], types: { text: 'string' } },
      verification: { strategy: 'self_reported', description: 'Reports resolved coordinates/address; only honest when a fix was acquired.' },
      timeoutMs: 20000,
      retryPolicy: { maxAttempts: 1 },
      async execute(input): Promise<ToolResult> {
        const result = await acquireLocationWithPriority();
        if (!result.location) {
          return fail(result.googleMapsError || 'Could not acquire location (permission denied or unavailable)', {
            retryable: false,
            errorKind: 'permission_denied',
          });
        }
        const mapsAction: MapsLocationAction = buildMapsActionFromLocation(result.location);
        if (shouldOpenGoogleMaps(typeof input.text === 'string' ? input.text : '')) {
          try {
            window.open(result.location.googleMapsUrl, '_blank', 'noopener,noreferrer');
          } catch {
            // popup blocked — card still shows the link
          }
        }
        return ok({
          output: { city: result.location.city, formattedAddress: result.location.formattedAddress },
          state: { userLocation: { lat: result.location.lat, lng: result.location.lng } },
          ui: [{ kind: 'maps_action', action: mapsAction }, pose()],
        });
      },
    },
    {
      name: 'chat.report',
      description: 'Terminal step: the accumulated task result is reported back to the user in chat.',
      category: 'communication',
      riskLevel: 'safe',
      cost: 'free',
      reliability: 1.0,
      capabilities: ['communication.report'],
      permissions: [],
      inputSchema: { optional: ['topic'], types: { topic: 'string' } },
      verification: { strategy: 'self_reported', description: 'The report itself is the deliverable.' },
      timeoutMs: 5000,
      async execute(input, ctx): Promise<ToolResult> {
        const topic = typeof input.topic === 'string' ? input.topic : '';
        return ok({
          output: { acknowledged: true, topic, memoriesAvailable: (ctx.relevantMemories ?? []).length },
          state: { memory: ctx.memory },
          ui: [],
        });
      },
    },
    {
      name: 'system.note',
      description: 'Record a non-executable part of a request as an honest note (no external effect).',
      category: 'system',
      riskLevel: 'safe',
      cost: 'free',
      reliability: 1.0,
      capabilities: ['system.note'],
      permissions: [],
      inputSchema: { required: ['text'], types: { text: 'string' } },
      verification: { strategy: 'self_reported', description: 'The note is stored in the task result.' },
      timeoutMs: 3000,
      async execute(input): Promise<ToolResult> {
        return ok({ output: { noted: String(input.text) } });
      },
    },

    // ------------------------------------------------------- memory tools
    {
      name: 'memory.remember',
      description: 'Store a durable fact in the memory service (worth-assessment and dedup apply).',
      category: 'memory',
      riskLevel: 'low',
      cost: 'free',
      reliability: 1.0,
      capabilities: ['memory.store'],
      permissions: ['memory.access'],
      inputSchema: {
        required: ['text'],
        types: { text: 'string' },
        validators: { text: (v) => String(v).trim().length >= 4 },
      },
      verification: { strategy: 'self_reported', description: 'Reports the store outcome (created/merged/superseded/rejected).' },
      timeoutMs: 3000,
      async execute(input): Promise<ToolResult> {
        const text = String(input.text);
        const outcome = memory.remember(text, { source: 'user_manual' });
        if (outcome.action === 'rejected') {
          return fail(`Memory rejected: ${outcome.reason}`, { retryable: false, errorKind: 'invalid_input' });
        }
        return ok({
          output: { action: outcome.action, id: outcome.record.id, content: outcome.record.content },
          ui: [],
        });
      },
    },
    {
      name: 'memory.recall',
      description: 'Retrieve the most relevant memories for a query (relevance-ranked, limited).',
      category: 'memory',
      riskLevel: 'low',
      cost: 'free',
      reliability: 1.0,
      capabilities: ['memory.recall'],
      permissions: ['memory.access'],
      inputSchema: { required: ['query'], optional: ['limit'], types: { query: 'string', limit: 'number' } },
      verification: { strategy: 'self_reported', description: 'Returns the ranked memory contents.' },
      timeoutMs: 3000,
      async execute(input): Promise<ToolResult> {
        const query = String(input.query);
        const limit = typeof input.limit === 'number' ? input.limit : 5;
        const records = memory.recall(query, { limit });
        return ok({
          output: { count: records.length, memories: records.map((r) => r.content) },
          ui: [],
        });
      },
    },
    {
      name: 'memory.search',
      description: 'Keyword search across stored memories.',
      category: 'memory',
      riskLevel: 'low',
      cost: 'free',
      reliability: 1.0,
      capabilities: ['memory.search'],
      permissions: ['memory.access'],
      inputSchema: { required: ['query'], optional: ['limit'], types: { query: 'string', limit: 'number' } },
      verification: { strategy: 'self_reported', description: 'Returns matching memory contents.' },
      timeoutMs: 3000,
      async execute(input): Promise<ToolResult> {
        const query = String(input.query);
        const limit = typeof input.limit === 'number' ? input.limit : 10;
        const records = memory.search(query, { limit });
        return ok({
          output: { count: records.length, memories: records.map((r) => r.content) },
          ui: [],
        });
      },
    },
  ];

  return tools;
}
