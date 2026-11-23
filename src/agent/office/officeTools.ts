/**
 * Office agent tools (spreadsheet + presentation) — Phase 9 conventions.
 *
 * Every tool talks to the local server's /api/office/* endpoints, which run
 * pure-JS writers/readers (ExcelJS / pptxgenjs) inside the allowed-filesystem
 * roots — 100% local files, zero Office/COM/Python, hard-capped payloads for
 * the 8 GB target (see officeCore.ts).
 *
 * Permissions: reads use 'filesystem.read' (default-granted); every mutation
 * uses 'filesystem.write' (default-DENY browser-side; the bridge grants it
 * session-scoped when the user explicitly asks for spreadsheet/presentation
 * work — the same doctrine as mouse/keyboard control).
 *
 * Two creation paths:
 *  - *.create tools: deterministic — the caller supplies the rows/slides.
 *  - *.generate tools: the server drafts content with ONE bounded text-only
 *    Gemini call (like research — online content acquisition) and writes the
 *    local file. No screenshots, no file uploads; artifacts stay on-device.
 */
import type { AgentTool, ToolResult } from '../types';
import { ok, fail } from '../types';

const FS_READ = ['filesystem.read'] as const;
const FS_WRITE = ['filesystem.write'] as const;

const REQUEST_TIMEOUT_MS = 120_000; // generation includes one model call

let BASE_URL = '';

/** Allow Node-based checks to target the server directly (browser default: same origin). */
export function setOfficeBackendBaseUrl(url: string): void {
  BASE_URL = url.replace(/\/$/, '');
}

interface OfficeResponse<T> {
  success: boolean;
  result?: T;
  error?: string;
}

async function post<T>(route: string, payload: Record<string, unknown>): Promise<OfficeResponse<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) return { success: false, error: `Server returned HTTP ${res.status}` };
    return (await res.json()) as OfficeResponse<T>;
  } catch (err: any) {
    if (controller.signal.aborted) return { success: false, error: 'Request timed out' };
    return { success: false, error: `Server unreachable: ${String(err?.message || err)}` };
  } finally {
    clearTimeout(timer);
  }
}

function toResult(res: OfficeResponse<Record<string, unknown>>): ToolResult {
  if (!res.success || !res.result) {
    return fail(res.error ?? 'Office operation failed', { errorKind: 'execution_error', retryable: false });
  }
  const { summary, ...rest } = res.result as { summary?: string };
  return ok({ output: { summary: summary ?? 'Office file written.', ...rest } });
}

const PATH_TYPES = { path: 'string', overwrite: 'boolean' } as Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>;

export function createOfficeTools(): AgentTool[] {
  return [
    {
      name: 'spreadsheet.create',
      description: 'Create a local .xlsx spreadsheet from explicit data: sheets with rows of cells (strings, numbers, booleans; a string starting with "=" becomes a formula).',
      category: 'office',
      riskLevel: 'medium',
      cost: 'cheap',
      reliability: 0.9,
      capabilities: ['spreadsheet.create', 'filesystem.create'],
      permissions: [...FS_WRITE],
      inputSchema: {
        optional: ['path', 'sheets', 'overwrite'],
        types: { ...PATH_TYPES, sheets: 'array' } as Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>,
      },
      verification: { strategy: 'state_check', description: 'The server re-opens the written file and verifies the sheet structure before reporting success.' },
      timeoutMs: 60_000,
      retryPolicy: { maxAttempts: 1 },
      async execute(input, _ctx): Promise<ToolResult> {
        const path = String(input.path ?? '').trim();
        if (!path) return fail('spreadsheet.create requires a file path (e.g. "budget.xlsx")', { errorKind: 'invalid_input', retryable: false });
        const sheets = Array.isArray(input.sheets)
          ? (input.sheets as Array<{ name?: unknown; rows?: unknown }>).map((s, i) => ({
              name: typeof s?.name === 'string' ? s.name : `Sheet${i + 1}`,
              rows: Array.isArray(s?.rows) ? (s.rows as unknown[][]) : [[]],
            }))
          : undefined;
        return toResult(await post('/api/office/spreadsheet/create', { path, sheets, overwrite: input.overwrite === true }));
      },
    },
    {
      name: 'spreadsheet.generate',
      description: 'Create a local .xlsx about a TOPIC: the server drafts the columns and data rows with one text-only model call (like research), then writes the file locally. Use when the user wants content, not just an empty file.',
      category: 'office',
      riskLevel: 'medium',
      cost: 'moderate',
      reliability: 0.75,
      capabilities: ['spreadsheet.generate'],
      permissions: [...FS_WRITE],
      inputSchema: {
        optional: ['path', 'topic', 'columns', 'rows', 'overwrite'],
        types: { ...PATH_TYPES, topic: 'string', columns: 'array', rows: 'number' } as Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>,
      },
      verification: { strategy: 'state_check', description: 'The file is re-opened and verified after the model content lands in it.' },
      timeoutMs: 120_000,
      retryPolicy: { maxAttempts: 1 },
      async execute(input, _ctx): Promise<ToolResult> {
        const path = String(input.path ?? '').trim();
        const topic = String(input.topic ?? '').trim();
        if (!path) return fail('spreadsheet.generate requires a file path', { errorKind: 'invalid_input', retryable: false });
        if (!topic) return fail('spreadsheet.generate requires a topic to research and tabulate', { errorKind: 'invalid_input', retryable: false });
        return toResult(await post('/api/office/generate', {
          kind: 'spreadsheet',
          path,
          topic,
          columns: Array.isArray(input.columns) ? input.columns : undefined,
          rows: typeof input.rows === 'number' ? input.rows : undefined,
          overwrite: input.overwrite === true,
        }));
      },
    },
    {
      name: 'spreadsheet.read',
      description: 'Read a local .xlsx: sheet names with dimensions, plus up to 1000 rows of the chosen sheet (bounded, default 200 rows).',
      category: 'office',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.95,
      capabilities: ['spreadsheet.read', 'filesystem.read'],
      permissions: [...FS_READ],
      inputSchema: {
        optional: ['path', 'sheet', 'maxRows'],
        types: { path: 'string', sheet: 'string', maxRows: 'number' } as Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>,
      },
      verification: { strategy: 'self_reported', description: 'Data is read directly from the file on disk.' },
      timeoutMs: 60_000,
      retryPolicy: { maxAttempts: 1 },
      async execute(input, _ctx): Promise<ToolResult> {
        const path = String(input.path ?? '').trim();
        if (!path) return fail('spreadsheet.read requires a file path', { errorKind: 'invalid_input', retryable: false });
        return toResult(await post('/api/office/spreadsheet/read', {
          path,
          sheet: typeof input.sheet === 'string' ? input.sheet : undefined,
          maxRows: typeof input.maxRows === 'number' ? input.maxRows : undefined,
        }));
      },
    },
    {
      name: 'spreadsheet.edit',
      description: 'Edit a local .xlsx: set_cells (anchor + rows, or explicit cells), append_rows, or add_sheet. Verified by re-opening the file.',
      category: 'office',
      riskLevel: 'medium',
      cost: 'cheap',
      reliability: 0.9,
      capabilities: ['spreadsheet.edit', 'filesystem.write'],
      permissions: [...FS_WRITE],
      inputSchema: {
        optional: ['path', 'ops', 'createIfMissing'],
        types: { path: 'string', ops: 'array', createIfMissing: 'boolean' } as Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>,
      },
      verification: { strategy: 'state_check', description: 'The server re-opens the file and verifies the last operation landed.' },
      timeoutMs: 60_000,
      retryPolicy: { maxAttempts: 1 },
      async execute(input, _ctx): Promise<ToolResult> {
        const path = String(input.path ?? '').trim();
        if (!path) return fail('spreadsheet.edit requires a file path', { errorKind: 'invalid_input', retryable: false });
        if (!Array.isArray(input.ops) || input.ops.length === 0) {
          return fail('spreadsheet.edit requires ops: [{type: "set_cells"|"append_rows"|"add_sheet", ...}]', { errorKind: 'invalid_input', retryable: false });
        }
        return toResult(await post('/api/office/spreadsheet/edit', { path, ops: input.ops, createIfMissing: input.createIfMissing === true }));
      },
    },
    {
      name: 'presentation.create',
      description: 'Create a local .pptx from explicit slides (titles + bullets + speaker notes). Deterministic — no model call.',
      category: 'office',
      riskLevel: 'medium',
      cost: 'cheap',
      reliability: 0.9,
      capabilities: ['presentation.create', 'filesystem.create'],
      permissions: [...FS_WRITE],
      inputSchema: {
        optional: ['path', 'title', 'slides', 'overwrite'],
        types: { ...PATH_TYPES, title: 'string', slides: 'array' } as Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>,
      },
      verification: { strategy: 'state_check', description: 'Post-write size + zip-container verification; failures are reported honestly.' },
      timeoutMs: 60_000,
      retryPolicy: { maxAttempts: 1 },
      async execute(input, _ctx): Promise<ToolResult> {
        const path = String(input.path ?? '').trim();
        if (!path) return fail('presentation.create requires a file path (e.g. "solar-system.pptx")', { errorKind: 'invalid_input', retryable: false });
        const slides = Array.isArray(input.slides)
          ? (input.slides as Array<Record<string, unknown>>).map((s) => ({
              title: typeof s?.title === 'string' ? s.title : undefined,
              bullets: Array.isArray(s?.bullets) ? s.bullets.map((b) => String(b)) : [],
              notes: typeof s?.notes === 'string' ? s.notes : undefined,
            }))
          : [];
        return toResult(await post('/api/office/presentation/create', {
          path,
          title: typeof input.title === 'string' ? input.title : undefined,
          slides,
          overwrite: input.overwrite === true,
        }));
      },
    },
    {
      name: 'presentation.generate',
      description: 'Create a local .pptx about a TOPIC: the server drafts the slides with one text-only model call (online content acquisition — like research), then writes the file locally. Nothing but the text prompt goes online.',
      category: 'office',
      riskLevel: 'medium',
      cost: 'moderate',
      reliability: 0.75,
      capabilities: ['presentation.generate'],
      permissions: [...FS_WRITE],
      inputSchema: {
        optional: ['path', 'topic', 'slides', 'overwrite'],
        types: { ...PATH_TYPES, topic: 'string', slides: 'number' } as Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>,
      },
      verification: { strategy: 'state_check', description: 'Post-write size + zip-container verification after the generated content lands.' },
      timeoutMs: 120_000,
      retryPolicy: { maxAttempts: 1 },
      async execute(input, _ctx): Promise<ToolResult> {
        const path = String(input.path ?? '').trim();
        const topic = String(input.topic ?? '').trim();
        if (!path) return fail('presentation.generate requires a file path', { errorKind: 'invalid_input', retryable: false });
        if (!topic) return fail('presentation.generate requires a topic to build the deck about', { errorKind: 'invalid_input', retryable: false });
        return toResult(await post('/api/office/generate', {
          kind: 'presentation',
          path,
          topic,
          slides: typeof input.slides === 'number' ? input.slides : undefined,
          overwrite: input.overwrite === true,
        }));
      },
    },
  ];
}
