/**
 * Browser tools (Phase 8) — Phase 3 Tool contract.
 *
 * Individual browser capabilities plus the `browser.use` compound-task
 * orchestrator. All tools are permission-gated ('browser.interaction'),
 * verify with page-state evidence, and fall back to the Phase 7 computer-use
 * layer when the controlled CDP browser is unavailable.
 */
import type { AgentTool, ToolErrorKind, ToolResult } from '../types';
import { ok, fail } from '../types';
import type { ControlError } from '../computer/mouseTypes';
import type { BrowserAgent } from './browserAgent';

const ERROR_KIND_MAP: Record<string, { errorKind: ToolErrorKind; retryable: boolean }> = {
  invalid_coordinates: { errorKind: 'invalid_input', retryable: false },
  target_not_found: { errorKind: 'not_found', retryable: true },
  backend_failed: { errorKind: 'execution_error', retryable: true },
  backend_unavailable: { errorKind: 'execution_error', retryable: false },
  timeout: { errorKind: 'timeout', retryable: true },
  cancelled: { errorKind: 'cancelled', retryable: false },
  permission_denied: { errorKind: 'permission_denied', retryable: false },
};

function mapControlError(err: unknown): ToolResult {
  if (err instanceof Error && (err as ControlError).kind) {
    const controlErr = err as ControlError;
    const mapped = ERROR_KIND_MAP[controlErr.kind] ?? { errorKind: 'execution_error' as ToolErrorKind, retryable: true };
    return fail(controlErr.message, { errorKind: mapped.errorKind, retryable: mapped.retryable });
  }
  return fail(`Browser action failed: ${String((err as any)?.message || err)}`, { errorKind: 'execution_error', retryable: true });
}

const NAVIGATE_SCHEMA = {
  optional: ['url', 'expectTitle', 'expectText', 'expectUrlContains'],
  types: { url: 'string', expectTitle: 'string', expectText: 'string', expectUrlContains: 'string' } as Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>,
};

export function createBrowserTools(agent: BrowserAgent): AgentTool[] {
  return [
    {
      name: 'browser.get_state',
      description: 'Read the controlled browser page state: URL, title, loading state, visible links, buttons, fields, headings, and open tabs.',
      category: 'web',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.9,
      capabilities: ['browser.get_state'],
      permissions: ['browser.interaction'],
      inputSchema: {},
      verification: { strategy: 'self_reported', description: 'The state is read directly from the controlled browser.' },
      timeoutMs: 20_000,
      async execute(_input, ctx): Promise<ToolResult> {
        try {
          const state = await agent.getState(ctx.signal, true);
          if (!state.available || !state.page) {
            return fail(state.error ?? 'Browser state unavailable', { errorKind: 'not_found', retryable: true });
          }
          const page = state.page;
          return ok({
            output: {
              summary: `Page: ${page.title || page.url} (${page.ready}). ${page.links.length} links, ${page.buttons.length} buttons, ${page.fields.length} fields.`,
              url: page.url,
              title: page.title,
              ready: page.ready,
              links: page.links.slice(0, 10),
              buttons: page.buttons.slice(0, 10),
              fields: page.fields.slice(0, 10),
              headings: page.headings.slice(0, 5),
              tabs: state.tabs,
            },
          });
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'browser.navigate',
      description: 'Navigate the controlled browser to a URL (http/https only) and verify the page loaded.',
      category: 'web',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.85,
      capabilities: ['browser.navigate', 'browser.open_url'],
      permissions: ['browser.interaction'],
      inputSchema: NAVIGATE_SCHEMA,
      verification: { strategy: 'state_check', description: 'Verified via loaded URL/title/heading evidence — never assumed from the dispatch.' },
      timeoutMs: 45_000,
      retryPolicy: { maxAttempts: 1 },
      async execute(input, ctx): Promise<ToolResult> {
        try {
          const result = await agent.navigate(
            String(input.url ?? ''),
            {
              expectTitle: input.expectTitle as string | undefined,
              expectText: input.expectText as string | undefined,
              expectUrlContains: input.expectUrlContains as string | undefined,
            },
            ctx.signal
          );
          return ok({ output: { summary: result.summary, ...result } });
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'browser.back',
      description: 'Navigate the controlled browser back to the previous page.',
      category: 'web',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.9,
      capabilities: ['browser.back'],
      permissions: ['browser.interaction'],
      inputSchema: {},
      verification: { strategy: 'state_check', description: 'Post-navigation page state is read and returned.' },
      timeoutMs: 30_000,
      async execute(_input, ctx): Promise<ToolResult> {
        try {
          const result = await agent.goBack(ctx.signal);
          return ok({ output: { summary: result.summary, ...result } });
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'browser.forward',
      description: 'Navigate the controlled browser forward.',
      category: 'web',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.9,
      capabilities: ['browser.forward'],
      permissions: ['browser.interaction'],
      inputSchema: {},
      verification: { strategy: 'state_check', description: 'Post-navigation page state is read and returned.' },
      timeoutMs: 30_000,
      async execute(_input, ctx): Promise<ToolResult> {
        try {
          const result = await agent.goForward(ctx.signal);
          return ok({ output: { summary: result.summary, ...result } });
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'browser.refresh',
      description: 'Reload the current page in the controlled browser.',
      category: 'web',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.9,
      capabilities: ['browser.refresh'],
      permissions: ['browser.interaction'],
      inputSchema: {},
      verification: { strategy: 'state_check', description: 'Reloaded page state is read and returned.' },
      timeoutMs: 30_000,
      async execute(_input, ctx): Promise<ToolResult> {
        try {
          const result = await agent.refresh(ctx.signal);
          return ok({ output: { summary: result.summary, ...result } });
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'browser.find',
      description: 'Find visible links, buttons, fields, or headings matching a text query on the current page.',
      category: 'web',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.9,
      capabilities: ['browser.find'],
      permissions: ['browser.interaction'],
      inputSchema: { optional: ['query'], types: { query: 'string' } },
      verification: { strategy: 'self_reported', description: 'Matches come from the current page-state snapshot.' },
      timeoutMs: 20_000,
      async execute(input, ctx): Promise<ToolResult> {
        try {
          const { matches, count } = await agent.find(String(input.query ?? ''), ctx.signal);
          if (count === 0) {
            return fail(`No matches for "${String(input.query).slice(0, 60)}" on the current page`, { errorKind: 'not_found', retryable: true });
          }
          return ok({ output: { summary: `Found ${count} match(es): ${matches.slice(0, 3).join('; ')}`, count, matches } });
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'browser.click',
      description: 'Click a visible link or button by its text in the controlled browser, then verify the page change.',
      category: 'web',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.8,
      capabilities: ['browser.click'],
      permissions: ['browser.interaction'],
      inputSchema: {
        optional: ['target', 'kind', 'expectUrlContains', 'expectText'],
        types: { target: 'string', kind: 'string', expectUrlContains: 'string', expectText: 'string' } as Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>,
        validators: { kind: (v) => v === 'link' || v === 'button' || v === 'any' },
      },
      verification: { strategy: 'state_check', description: 'Verified via URL change / expected evidence after the click.' },
      timeoutMs: 30_000,
      retryPolicy: { maxAttempts: 1 },
      async execute(input, ctx): Promise<ToolResult> {
        try {
          const result = await agent.click(String(input.target ?? ''), {
            kind: input.kind as any,
            expectUrlContains: input.expectUrlContains as string | undefined,
            expectText: input.expectText as string | undefined,
          }, ctx.signal);
          return ok({ output: { summary: result.summary, ...result } });
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'browser.type',
      description: 'Type text into a visible page field (matched by placeholder/name/label) in the controlled browser.',
      category: 'web',
      riskLevel: 'medium',
      cost: 'cheap',
      reliability: 0.85,
      capabilities: ['browser.type'],
      permissions: ['browser.interaction'],
      inputSchema: {
        optional: ['text', 'field'],
        types: { text: 'string', field: 'string' } as Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>,
      },
      verification: { strategy: 'self_reported', description: 'Field value set with proper input events; sensitive text masked in results.' },
      timeoutMs: 20_000,
      retryPolicy: { maxAttempts: 1 },
      async execute(input, ctx): Promise<ToolResult> {
        try {
          const result = await agent.type(String(input.text ?? ''), String(input.field ?? input.target ?? ''), ctx.signal);
          return ok({ output: { summary: result.summary, ...result } });
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'browser.scroll',
      description: 'Scroll the controlled browser page up or down.',
      category: 'web',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.95,
      capabilities: ['browser.scroll'],
      permissions: ['browser.interaction'],
      inputSchema: {
        optional: ['direction', 'amount'],
        types: { direction: 'string', amount: 'number' } as Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>,
        validators: { direction: (v) => v === 'up' || v === 'down' },
      },
      verification: { strategy: 'self_reported', description: 'Scroll executed in the controlled browser.' },
      timeoutMs: 15_000,
      async execute(input, ctx): Promise<ToolResult> {
        try {
          const result = await agent.scroll((input.direction as 'up' | 'down') ?? 'down', (input.amount as number) ?? 3, ctx.signal);
          return ok({ output: { summary: result.summary, ...result } });
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'browser.wait',
      description: 'Wait (bounded, adaptive) until the page URL/title/content matches an expectation.',
      category: 'web',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.85,
      capabilities: ['browser.wait', 'browser.verify'],
      permissions: ['browser.interaction'],
      inputSchema: {
        optional: ['urlContains', 'titleContains', 'textContains', 'timeoutMs'],
        types: { urlContains: 'string', titleContains: 'string', textContains: 'string', timeoutMs: 'number' } as Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>,
      },
      verification: { strategy: 'state_check', description: 'The wait itself is the verification: bounded polling of page state.' },
      timeoutMs: 30_000,
      async execute(input, ctx): Promise<ToolResult> {
        try {
          const wait = await agent.waitFor({
            urlContains: input.urlContains as string | undefined,
            titleContains: input.titleContains as string | undefined,
            textContains: input.textContains as string | undefined,
          }, { timeoutMs: (input.timeoutMs as number) ?? 8000 }, ctx.signal);
          if (wait.satisfied) {
            return ok({ output: { summary: 'Expected page state appeared.', observations: wait.observations } });
          }
          return fail('Expected page state did not appear in time', { errorKind: 'timeout', retryable: true });
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'browser.use',
      description: 'Run a compound browser task end-to-end: navigate, find, click, type, and verify pages in the Krisha-controlled browser. Requires the full goal text.',
      category: 'web',
      riskLevel: 'medium',
      cost: 'moderate',
      reliability: 0.6,
      capabilities: ['browser.use', 'browser.autonomous'],
      permissions: ['browser.interaction'],
      inputSchema: {
        optional: ['goal'],
        types: { goal: 'string' } as Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>,
      },
      verification: {
        strategy: 'state_check',
        description: 'Every action is verified with page-state evidence (URL/title/content); failures stop the run honestly.',
      },
      timeoutMs: 180_000,
      retryPolicy: { maxAttempts: 1 },
      async execute(input, ctx): Promise<ToolResult> {
        const goal = String(input.goal ?? ctx.userRequest ?? '').trim();
        if (!goal) {
          return fail('browser.use requires a goal (input.goal or the original user request)', { errorKind: 'invalid_input', retryable: false });
        }
        try {
          const { buildBrowserIntents } = await import('./browserDecider');
          const intents = buildBrowserIntents(goal);
          if (intents.length === 0) {
            return fail('No browser actions could be planned from the goal', { errorKind: 'invalid_input', retryable: false });
          }
          const result = await agent.run(goal, intents, ctx.signal);
          if (result.status === 'cancelled') {
            return fail(result.summary, { errorKind: 'cancelled', retryable: false, output: result });
          }
          if (result.status === 'failed' || result.status === 'partial') {
            return fail(result.summary, { errorKind: 'execution_error', retryable: false, output: result });
          }
          return ok({ output: { summary: result.summary, ...result } });
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
  ];
}
