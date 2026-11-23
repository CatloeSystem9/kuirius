/**
 * Live Screen Perception tools — permission-gated ('screen.observation',
 * default-deny) additions to the Phase 4 screen tool set:
 *
 *   screen.live          — start/stop/status of the adaptive live watcher
 *   screen.understanding — the current SPF-screened understanding (cached,
 *                          cost 'free') with an optional explicit refresh
 *
 * Every output is screened through the Screen Privacy Firewall (same policy
 * as the Phase 4 tools). Starting/stopping the watcher is 'medium' risk
 * (continuous observation is a privacy-relevant mode the user must be able
 * to see and stop); reading the cached understanding is 'low'/'free'.
 */
import type { AgentTool, ToolResult } from '../types';
import { ok, fail } from '../types';
import type { LiveScreenWatcher } from './liveWatcher';
import type { ScreenUnderstandingService } from './screenUnderstanding';
import { spfScreenItem } from '../spf/index';

function screened(text: string, observationId?: string): string {
  return spfScreenItem(text, 'tool:screen.live', observationId, 'tool-output').text;
}

export function createLivePerceptionTools(
  watcher: LiveScreenWatcher,
  understanding: ScreenUnderstandingService
): AgentTool[] {
  return [
    {
      name: 'screen.live',
      description:
        'Start or stop continuous lightweight screen watching. While active, Krisha tracks screen changes at an adaptive, resource-bounded rate (no continuous AI processing) and keeps a recent understanding of the screen.',
      category: 'vision',
      riskLevel: 'medium',
      cost: 'cheap',
      reliability: 0.9,
      capabilities: ['screen.live', 'screen.observe'],
      permissions: ['screen.observation'],
      inputSchema: {
        required: ['enable'],
        types: { enable: 'boolean' },
      },
      verification: {
        strategy: 'self_reported',
        description: 'Reports the actual watcher state after the operation; failures are honest.',
      },
      timeoutMs: 5000,
      async execute(input): Promise<ToolResult> {
        const enable = input.enable === true;
        try {
          if (enable) {
            watcher.start();
            understanding.attach();
            const stats = watcher.getStats();
            return ok({
              output: {
                summary: screened(
                  `Live screen watching started (adaptive ~${Math.round((stats.currentIntervalMs ?? 1500) / 100) / 10}s cadence). The Screen Privacy Firewall continues to protect everything observed.`,
                  'live-start'
                ),
                running: watcher.isRunning(),
                intervals: stats.currentIntervalMs,
              },
            });
          }
          watcher.stop();
          return ok({
            output: {
              summary: screened('Live screen watching stopped.', 'live-stop'),
              running: watcher.isRunning(),
            },
          });
        } catch (err) {
          return fail(`Could not change live watching: ${String((err as any)?.message || err)}`, {
            errorKind: 'permission_denied',
            retryable: false,
          });
        }
      },
    },
    {
      name: 'screen.understanding',
      description:
        "Read Krisha's current understanding of the user's screen: active application, visible (privacy-screened) text lines, their approximate positions, and freshness. Optionally forces a refresh.",
      category: 'vision',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.85,
      capabilities: ['screen.understanding', 'screen.describe'],
      permissions: ['screen.observation'],
      inputSchema: {
        optional: ['refresh', 'question'],
        types: { refresh: 'boolean', question: 'string' },
      },
      verification: {
        strategy: 'self_reported',
        description: 'Reflects only what local OCR actually recognized; empty understanding is reported honestly.',
      },
      timeoutMs: 20000,
      async execute(input): Promise<ToolResult> {
        try {
          const snapshot =
            input.refresh === true
              ? await understanding.requestRefresh('explicit')
              : understanding.getLatest();
          if (!snapshot) {
            return ok({
              output: {
                summary:
                  'No recent screen understanding. Enable live watching (screen.live) or run screen.observe for a one-shot analysis.',
                available: false,
              },
            });
          }
          const texts = snapshot.texts.slice(0, 12).map((t) => ({
            text: spfScreenItem(t.text, 'tool:screen.understanding', snapshot.id, 'tool-output').text,
            bounds: t.bounds,
          }));
          const ageS = Math.max(0, Math.round((Date.now() - snapshot.at) / 1000));
          return ok({
            output: {
              summary: screened(
                `Active app: ${snapshot.application || snapshot.activeWindow.title || 'unknown'} — understood ${texts.length}/${snapshot.totalLines} lines ${ageS}s ago${snapshot.redactedLines ? ` (${snapshot.redactedLines} privacy-screened)` : ''}.`,
                snapshot.id
              ),
              available: true,
              application: snapshot.application ? screened(snapshot.application, snapshot.id) : undefined,
              activeWindow: snapshot.activeWindow,
              texts,
              totalLines: snapshot.totalLines,
              redactedLines: snapshot.redactedLines,
              capturedAt: snapshot.capturedAt,
              understoodAt: snapshot.at,
              ageSeconds: ageS,
              source: snapshot.source,
              ocrMs: snapshot.ocrMs,
            },
          });
        } catch (err) {
          return fail(`Screen understanding failed: ${String((err as any)?.message || err)}`, {
            errorKind: 'execution_error',
            retryable: true,
          });
        }
      },
    },
  ];
}
