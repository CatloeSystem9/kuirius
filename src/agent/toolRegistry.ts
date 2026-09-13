/**
 * Tool Registry (Phase 3) — the authoritative source of tool knowledge.
 *
 * Discovery:    list / names / catalog / describe / findByCategory /
 *               findByCapability / findAvailable
 * Contract:     input schemas, permissions, risk, verification, cost
 * Execution:    validateInvocation → permission check → execute →
 *               normalized ToolResult (toolId, errorKind, duration, ...)
 * Events:       TOOL_REGISTERED / TOOL_UNREGISTERED / TOOL_STARTED /
 *               TOOL_COMPLETED / TOOL_FAILED on the shared AgentEventBus
 *
 * The registry itself stays DOM-free; browser-backed tools are registered at
 * runtime (browserTools.ts), mock tools by tests. All Phase 1 fields remain
 * optional so minimal legacy tools keep registering unchanged.
 */
import type { AgentTool, ToolContext, ToolErrorKind, ToolInputSchema, ToolPermission, ToolResult } from './types';
import type { AgentEventBus } from './events';
import type { PermissionManager } from './permissions';

export interface ToolCatalogEntry {
  name: string;
  description: string;
  category: string;
  riskLevel: string;
  capabilities: string[];
  permissions: ToolPermission[];
  cost: string;
  timeoutMs?: number;
  retryPolicy?: { maxAttempts?: number };
  verification?: { strategy: string; description?: string };
  inputSchema?: ToolInputSchema;
}

function inferErrorKind(error: string | undefined): ToolErrorKind {
  const e = (error ?? '').toLowerCase();
  if (e.includes('permission') || e.includes('denied') || e.includes('not allowed')) return 'permission_denied';
  if (e.includes('timeout') || e.includes('timed out')) return 'timeout';
  if (e.includes('cancel') || e.includes('abort')) return 'cancelled';
  if (e.includes('not found') || e.includes('unknown tool')) return 'not_found';
  if (e.includes('invalid') || e.includes('required') || e.includes('missing')) return 'invalid_input';
  return 'execution_error';
}

/** Retryability by error kind when the tool did not declare it explicitly. */
function retryableForKind(kind: ToolErrorKind): boolean {
  switch (kind) {
    case 'timeout':
    case 'execution_error':
      return true;
    default:
      return false;
  }
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export class ToolRegistry {
  private tools = new Map<string, AgentTool>();
  private bus: AgentEventBus | null;

  constructor(bus?: AgentEventBus) {
    this.bus = bus ?? null;
  }

  register(tool: AgentTool): void {
    if (!tool?.name) throw new Error('Tool must have a name');
    if (typeof tool.execute !== 'function') throw new Error(`Tool "${tool.name}" must implement execute()`);
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
    this.bus?.emit({ name: 'TOOL_REGISTERED', payload: { tool: tool.name, category: tool.category, capabilities: tool.capabilities ?? [] }, timestamp: Date.now() });
  }

  registerAll(tools: AgentTool[]): void {
    for (const tool of tools) this.register(tool);
  }

  unregister(name: string): boolean {
    const removed = this.tools.delete(name);
    if (removed) {
      this.bus?.emit({ name: 'TOOL_UNREGISTERED', payload: { tool: name }, timestamp: Date.now() });
    }
    return removed;
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): AgentTool[] {
    return Array.from(this.tools.values());
  }

  names(): string[] {
    return Array.from(this.tools.keys());
  }

  findByCategory(category: string): AgentTool[] {
    return this.list().filter((t) => t.category === category);
  }

  findByCapability(capability: string): AgentTool[] {
    return this.list().filter((t) => (t.capabilities ?? []).includes(capability));
  }

  /** Tools whose declared permissions are all currently granted. */
  findAvailable(permissions?: PermissionManager): AgentTool[] {
    if (!permissions) return this.list();
    return this.list().filter((t) => permissions.missing(t.permissions).length === 0);
  }

  describe(name: string): ToolCatalogEntry | null {
    const tool = this.tools.get(name);
    return tool ? this.toCatalogEntry(tool) : null;
  }

  catalog(): ToolCatalogEntry[] {
    return this.list().map((t) => this.toCatalogEntry(t));
  }

  private toCatalogEntry(tool: AgentTool): ToolCatalogEntry {
    return {
      name: tool.name,
      description: tool.description,
      category: tool.category,
      riskLevel: tool.riskLevel,
      capabilities: tool.capabilities ?? [],
      permissions: tool.permissions ?? [],
      cost: tool.cost ?? 'cheap',
      timeoutMs: tool.timeoutMs,
      retryPolicy: tool.retryPolicy,
      verification: tool.verification
        ? { strategy: tool.verification.strategy, description: tool.verification.description }
        : undefined,
      inputSchema: tool.inputSchema,
    };
  }

  // ------------------------------------------------------------- validation

  /** Validate an invocation against the tool's declared input schema. */
  validateInvocation(name: string, input: Record<string, unknown> | undefined): ValidationResult {
    const tool = this.tools.get(name);
    if (!tool) return { valid: false, errors: [`Unknown tool "${name}"`] };
    const errors: string[] = [];
    const schema = tool.inputSchema;
    const value = input ?? {};

    if (schema) {
      for (const key of schema.required ?? []) {
        const v = value[key];
        if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
          errors.push(`Missing required input "${key}"`);
        }
      }
      for (const [key, expected] of Object.entries(schema.types ?? {})) {
        const v = value[key];
        if (v === undefined) continue;
        const actual = Array.isArray(v) ? 'array' : typeof v;
        if (actual !== expected) {
          errors.push(`Input "${key}" must be ${expected} (got ${actual})`);
        }
      }
      for (const [key, validator] of Object.entries(schema.validators ?? {})) {
        const v = value[key];
        if (v === undefined) continue;
        let ok = false;
        try {
          ok = validator(v);
        } catch {
          ok = false;
        }
        if (!ok) errors.push(`Input "${key}" failed validation`);
      }
      // Reject unexpected keys to catch malformed requests early.
      const known = new Set([...(schema.required ?? []), ...(schema.optional ?? [])]);
      if (known.size > 0) {
        for (const key of Object.keys(value)) {
          if (!known.has(key)) errors.push(`Unexpected input "${key}"`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  // -------------------------------------------------------------- execution

  /**
   * Execute a tool with full contract enforcement and result normalization.
   * Never throws: every outcome is a structured ToolResult.
   */
  async execute(name: string, input: Record<string, unknown> | undefined, ctx?: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return this.failure(name, 'not_found', `Unknown tool "${name}"`, false);
    }

    // Permissions
    const missing = ctx?.permissions?.missing(tool.permissions) ?? [];
    if (missing.length > 0) {
      return this.failure(name, 'permission_denied', `Permission denied: missing ${missing.join(', ')}`, false, {
        missingPermissions: missing,
      });
    }

    // Input validation
    const validation = this.validateInvocation(name, input);
    if (!validation.valid) {
      return this.failure(name, 'invalid_input', `Invalid input for "${name}": ${validation.errors.join('; ')}`, false, {
        validationErrors: validation.errors,
      });
    }

    const startedAt = Date.now();
    this.bus?.emit({ name: 'TOOL_STARTED', payload: { tool: name }, timestamp: startedAt });

    let result: ToolResult;
    try {
      const raw = await tool.execute(input ?? {}, ctx ?? this.nullContext());
      result = { ...raw };
    } catch (err: any) {
      const aborted = ctx?.signal?.aborted || err?.name === 'AbortError';
      const kind: ToolErrorKind = aborted ? 'cancelled' : 'execution_error';
      result = this.failure(name, kind, aborted ? 'Tool execution cancelled' : String(err?.message || err), !aborted);
      result.timestamp = Date.now();
      result.durationMs = Date.now() - startedAt;
      this.bus?.emit({ name: aborted ? 'TOOL_CANCELLED' : 'TOOL_FAILED', payload: { tool: name, error: result.error }, timestamp: Date.now() });
      return result;
    }

    // Normalization — one common shape for every tool.
    result.toolId = name;
    result.timestamp = Date.now();
    result.durationMs = Date.now() - startedAt;
    if (!result.success && !result.errorKind) {
      result.errorKind = inferErrorKind(result.error);
    }
    if (!result.success && result.retryable === undefined) {
      result.retryable = retryableForKind(result.errorKind ?? 'execution_error');
    }

    this.bus?.emit({
      name: result.success ? 'TOOL_COMPLETED' : 'TOOL_FAILED',
      payload: { tool: name, durationMs: result.durationMs, error: result.error },
      timestamp: Date.now(),
    });
    return result;
  }

  private failure(toolId: string, errorKind: ToolErrorKind, error: string, retryable: boolean, metadata?: Record<string, unknown>): ToolResult {
    return {
      success: false,
      error,
      errorKind,
      retryable,
      toolId,
      timestamp: Date.now(),
      metadata,
    };
  }

  private nullContext(): ToolContext {
    return {
      taskId: 'detached',
      stepId: 'detached',
      signal: new AbortController().signal,
      memory: {},
    };
  }
}
