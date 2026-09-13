/**
 * Filesystem + Application tools (Phase 9) — Phase 3 Tool contract.
 *
 * Permissions: reads/list/search use 'filesystem.read' (default-granted);
 * every mutation uses 'filesystem.write' (default-DENY — delete is high-risk
 * and requires the write permission plus the confirmation-policy hook).
 * Application tools use 'application.launch'. Verification is evidence-based
 * via the services (re-inspection after mutations); destructive operations
 * are never retried.
 */
import type { AgentTool, ToolErrorKind, ToolPermission, ToolResult } from '../types';
import { ok, fail } from '../types';
import type { ControlError } from '../computer/mouseTypes';
import type { FsActionResult } from './systemTypes';
import type { FilesystemService, ApplicationService } from './systemServices';

const FS_READ: ToolPermission[] = ['filesystem.read'];
const FS_WRITE: ToolPermission[] = ['filesystem.write'];
const APP_PERM: ToolPermission[] = ['application.launch'];

function mapControlError(err: unknown): ToolResult {
  if (err instanceof Error && (err as ControlError).kind) {
    const controlErr = err as ControlError;
    return fail(controlErr.message, { errorKind: 'invalid_input', retryable: false });
  }
  return fail(`Filesystem operation failed: ${String((err as any)?.message || err)}`, { errorKind: 'execution_error', retryable: false });
}

function toResult(result: FsActionResult): ToolResult {
  if (result.verified || result.uncertain) {
    // `uncertain` operations dispatched successfully but lack full evidence —
    // reported as success with honest uncertainty, never as false certainty.
    return ok({ output: result });
  }
  return fail(result.summary, { errorKind: 'execution_error', retryable: false, output: result });
}

const PATH_SCHEMA = {
  optional: ['path'],
  types: { path: 'string' } as Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>,
};

export function createSystemTools(fs: FilesystemService, apps: ApplicationService): AgentTool[] {
  return [
    {
      name: 'filesystem.list',
      description: 'List the contents of a real directory on disk (bounded to 200 entries).',
      category: 'system',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.95,
      capabilities: ['filesystem.list'],
      permissions: FS_READ,
      inputSchema: PATH_SCHEMA,
      verification: { strategy: 'self_reported', description: 'Directory listing is read directly from the OS.' },
      timeoutMs: 15_000,
      async execute(input): Promise<ToolResult> {
        try {
          return toResult(await fs.list(String(input.path ?? '')));
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'filesystem.search',
      description: 'Search real files and directories by name under a root path (bounded depth and entry count).',
      category: 'system',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.9,
      capabilities: ['filesystem.search'],
      permissions: FS_READ,
      inputSchema: {
        optional: ['root', 'query', 'maxDepth'],
        types: { root: 'string', query: 'string', maxDepth: 'number' } as Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>,
      },
      verification: { strategy: 'self_reported', description: 'Matches come from a bounded real-disk walk.' },
      timeoutMs: 30_000,
      async execute(input): Promise<ToolResult> {
        try {
          return toResult(await fs.search(String(input.root ?? ''), String(input.query ?? '')));
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'filesystem.inspect',
      description: 'Inspect real file/directory metadata: kind, size, modification time, text-readability.',
      category: 'system',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.95,
      capabilities: ['filesystem.inspect'],
      permissions: FS_READ,
      inputSchema: PATH_SCHEMA,
      verification: { strategy: 'self_reported', description: 'Metadata is read directly from the OS.' },
      timeoutMs: 15_000,
      async execute(input): Promise<ToolResult> {
        try {
          return toResult(await fs.inspect(String(input.path ?? '')));
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'filesystem.read',
      description: 'Read a real text file (bounded 64KB, text extensions only, binary files refused). Use offset for pagination.',
      category: 'system',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.95,
      capabilities: ['filesystem.read'],
      permissions: FS_READ,
      inputSchema: {
        optional: ['path', 'offset'],
        types: { path: 'string', offset: 'number' } as Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>,
      },
      verification: { strategy: 'self_reported', description: 'Content is read directly from the OS with binary sniffing.' },
      timeoutMs: 15_000,
      async execute(input): Promise<ToolResult> {
        try {
          return toResult(await fs.read(String(input.path ?? ''), (input.offset as number) ?? 0));
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'filesystem.create',
      description: 'Create a real empty file or directory (refuses to overwrite existing targets).',
      category: 'system',
      riskLevel: 'medium',
      cost: 'cheap',
      reliability: 0.95,
      capabilities: ['filesystem.create'],
      permissions: FS_WRITE,
      inputSchema: {
        optional: ['path', 'type', 'content'],
        types: { path: 'string', type: 'string', content: 'string' } as Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>,
        validators: { type: (v) => v === 'file' || v === 'dir' },
      },
      verification: { strategy: 'state_check', description: 'Re-inspected after creation: the target must exist with the right kind.' },
      timeoutMs: 15_000,
      retryPolicy: { maxAttempts: 1 },
      async execute(input): Promise<ToolResult> {
        try {
          return toResult(await fs.create(String(input.path ?? ''), (input.type as 'file' | 'dir') ?? 'file', input.content as string | undefined));
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'filesystem.rename',
      description: 'Rename a real file or directory within its folder (refuses to clobber existing names).',
      category: 'system',
      riskLevel: 'medium',
      cost: 'cheap',
      reliability: 0.95,
      capabilities: ['filesystem.rename'],
      permissions: FS_WRITE,
      inputSchema: {
        optional: ['path', 'newName'],
        types: { path: 'string', newName: 'string' } as Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>,
      },
      verification: { strategy: 'state_check', description: 'Verified: old path gone AND new path exists after the rename.' },
      timeoutMs: 15_000,
      retryPolicy: { maxAttempts: 1 },
      async execute(input): Promise<ToolResult> {
        try {
          return toResult(await fs.rename(String(input.path ?? ''), String(input.newName ?? '')));
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'filesystem.copy',
      description: 'Copy a real file or directory (recursive for directories; refuses to overwrite unless overwrite=true).',
      category: 'system',
      riskLevel: 'medium',
      cost: 'cheap',
      reliability: 0.95,
      capabilities: ['filesystem.copy'],
      permissions: FS_WRITE,
      inputSchema: {
        optional: ['from', 'to', 'overwrite'],
        types: { from: 'string', to: 'string', overwrite: 'boolean' } as Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>,
      },
      verification: { strategy: 'state_check', description: 'Verified: destination exists with matching size.' },
      timeoutMs: 60_000,
      retryPolicy: { maxAttempts: 1 },
      async execute(input): Promise<ToolResult> {
        try {
          return toResult(await fs.copy(String(input.from ?? ''), String(input.to ?? ''), input.overwrite === true));
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'filesystem.move',
      description: 'Move/relocate a real file or directory (refuses to overwrite unless overwrite=true).',
      category: 'system',
      riskLevel: 'medium',
      cost: 'cheap',
      reliability: 0.95,
      capabilities: ['filesystem.move'],
      permissions: FS_WRITE,
      inputSchema: {
        optional: ['from', 'to', 'overwrite'],
        types: { from: 'string', to: 'string', overwrite: 'boolean' } as Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>,
      },
      verification: { strategy: 'state_check', description: 'Verified: source gone AND destination exists.' },
      timeoutMs: 60_000,
      retryPolicy: { maxAttempts: 1 },
      async execute(input): Promise<ToolResult> {
        try {
          return toResult(await fs.move(String(input.from ?? ''), String(input.to ?? ''), input.overwrite === true));
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'filesystem.delete',
      description: 'Delete a real file or directory. High-risk: requires the filesystem.write permission; non-empty directories need explicit recursive=true. Never blindly retried.',
      category: 'system',
      riskLevel: 'high',
      cost: 'cheap',
      reliability: 0.95,
      capabilities: ['filesystem.delete'],
      permissions: FS_WRITE,
      inputSchema: {
        optional: ['path', 'recursive'],
        types: { path: 'string', recursive: 'boolean' } as Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>,
      },
      verification: { strategy: 'state_check', description: 'Verified: the target no longer exists after deletion.' },
      timeoutMs: 30_000,
      retryPolicy: { maxAttempts: 1 },
      async execute(input): Promise<ToolResult> {
        try {
          return toResult(await fs.delete(String(input.path ?? ''), input.recursive === true));
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'filesystem.open_file',
      description: 'Open a real file with its Windows-associated application (validated path; window confirmation requires screen observation).',
      category: 'system',
      riskLevel: 'medium',
      cost: 'cheap',
      reliability: 0.8,
      capabilities: ['filesystem.open_file', 'application.open_file'],
      permissions: FS_READ,
      inputSchema: PATH_SCHEMA,
      verification: { strategy: 'self_reported', description: 'Association dispatch confirmed by the OS; window appearance reported as uncertain.' },
      timeoutMs: 15_000,
      retryPolicy: { maxAttempts: 1 },
      async execute(input): Promise<ToolResult> {
        try {
          return toResult(await fs.openFile(String(input.path ?? '')));
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'application.find',
      description: 'Search discovered Windows applications (Start Menu + PATH registry, cached).',
      category: 'system',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.9,
      capabilities: ['application.find'],
      permissions: APP_PERM,
      inputSchema: { optional: ['query'], types: { query: 'string' } },
      verification: { strategy: 'self_reported', description: 'Discovery reads Start Menu shortcuts and PATH entries.' },
      timeoutMs: 30_000,
      async execute(input): Promise<ToolResult> {
        try {
          return toResult(await apps.find(String(input.query ?? '')));
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'application.launch',
      description: 'Launch a discovered Windows application by name (allowlist-based; never arbitrary command strings).',
      category: 'system',
      riskLevel: 'medium',
      cost: 'cheap',
      reliability: 0.8,
      capabilities: ['application.launch'],
      permissions: APP_PERM,
      inputSchema: { optional: ['name'], types: { name: 'string' } },
      verification: { strategy: 'state_check', description: 'Verified via the process table after dispatch; uncertain if the process has not appeared yet.' },
      timeoutMs: 30_000,
      retryPolicy: { maxAttempts: 1 },
      async execute(input): Promise<ToolResult> {
        try {
          return toResult(await apps.launch(String(input.name ?? '')));
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'application.status',
      description: 'Check whether a Windows application/process is running and get its PIDs.',
      category: 'system',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.95,
      capabilities: ['application.status'],
      permissions: APP_PERM,
      inputSchema: { optional: ['name'], types: { name: 'string' } },
      verification: { strategy: 'self_reported', description: 'Process table read directly.' },
      timeoutMs: 20_000,
      async execute(input): Promise<ToolResult> {
        try {
          return toResult(await apps.status(String(input.name ?? '')));
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'application.close',
      description: 'Close a running Windows application by process ID or by application name (high-risk; never blindly retried).',
      category: 'system',
      riskLevel: 'high',
      cost: 'cheap',
      reliability: 0.9,
      capabilities: ['application.close'],
      permissions: APP_PERM,
      inputSchema: {
        optional: ['pid', 'name', 'force'],
        types: { pid: 'number', name: 'string', force: 'boolean' } as Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>,
      },
      verification: { strategy: 'state_check', description: 'Verified via the terminate result.' },
      timeoutMs: 20_000,
      retryPolicy: { maxAttempts: 1 },
      async execute(input): Promise<ToolResult> {
        try {
          const force = input.force === true;
          const pid = input.pid as number | undefined;
          const name = input.name as string | undefined;
          if (pid) return toResult(await apps.close(pid, force));
          if (name) {
            const status = await apps.status(name);
            const first = status.pids?.[0];
            if (!first) return fail(`${name} is not running`, { errorKind: 'not_found', retryable: false });
            return toResult(await apps.close(first, force));
          }
          return fail('application.close requires a pid or name', { errorKind: 'invalid_input', retryable: false });
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'application.focus',
      description: 'Bring an application window to the foreground by process ID or name (best-effort in Windows).',
      category: 'system',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.7,
      capabilities: ['application.focus'],
      permissions: APP_PERM,
      inputSchema: {
        optional: ['pid', 'name'],
        types: { pid: 'number', name: 'string' } as Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>,
      },
      verification: { strategy: 'self_reported', description: 'Focus dispatch result reported honestly (uncertain when not confirmable).' },
      timeoutMs: 20_000,
      async execute(input): Promise<ToolResult> {
        try {
          const pid = input.pid as number | undefined;
          const name = input.name as string | undefined;
          if (pid) return toResult(await apps.focus(pid));
          if (name) {
            const status = await apps.status(name);
            const first = status.pids?.[0];
            if (!first) return fail(`${name} is not running`, { errorKind: 'not_found', retryable: false });
            return toResult(await apps.focus(first));
          }
          return fail('application.focus requires a pid or name', { errorKind: 'invalid_input', retryable: false });
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'filesystem.find_open',
      description: 'Compound: search the real filesystem for a file by name and open the best match with its associated application.',
      category: 'system',
      riskLevel: 'medium',
      cost: 'cheap',
      reliability: 0.8,
      capabilities: ['filesystem.find_open'],
      permissions: FS_READ,
      inputSchema: {
        optional: ['root', 'query'],
        types: { root: 'string', query: 'string' } as Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>,
      },
      verification: { strategy: 'state_check', description: 'Search evidence from the real disk; open dispatch confirmed by the OS with honest uncertainty about the window.' },
      timeoutMs: 45_000,
      retryPolicy: { maxAttempts: 1 },
      async execute(input): Promise<ToolResult> {
        try {
          const search = await fs.search(String(input.root ?? ''), String(input.query ?? ''));
          if (!search.verified || !search.matches || search.matches.length === 0) {
            return fail(`No files matching "${String(input.query).slice(0, 60)}" found under the root`, { errorKind: 'not_found', retryable: true });
          }
          const target = search.matches[0];
          const opened = await fs.openFile(target.path);
          if (!opened.verified && !opened.uncertain) {
            return fail(opened.summary, { errorKind: 'execution_error', retryable: false });
          }
          return ok({
            output: {
              summary: `Found "${target.name}" and opened it with its associated application (${search.matches.length} match(es) total).`,
              found: target,
              totalMatches: search.matches.length,
              ...opened,
            },
          });
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
  ];
}
