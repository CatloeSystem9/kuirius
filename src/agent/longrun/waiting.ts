/**
 * Bounded adaptive waiting (Phase 19, spec §13) — WAIT → WAKE → VERIFY →
 * CONTINUE. A single timer at a time with DOUBLING intervals (adaptive), a
 * hard timeout, an optional external wake signal, and bounded total polls.
 * Waiting consumes as little CPU as possible: no tight loops, no fixed
 * high-frequency polling.
 */
export interface WaitOptions {
  /** Predicate evaluated per wake. May be async (one bounded call per poll). */
  check: () => boolean | Promise<boolean>;
  /** Hard timeout — the wait is BLOCKED after this. */
  timeoutMs: number;
  /** First poll interval; doubles up to maxPollMs. */
  pollMs?: number;
  maxPollMs?: number;
  /** Upper bound on polls regardless of timeout. */
  maxPolls?: number;
  /** External wake (event-driven path): calling this re-checks immediately. */
  signal?: AbortSignal;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export type WaitResult =
  | { status: 'satisfied'; polls: number; elapsedMs: number }
  | { status: 'timeout'; polls: number; elapsedMs: number }
  | { status: 'cancelled'; polls: number; elapsedMs: number };

const DEFAULT_POLL_MS = 500;
const DEFAULT_MAX_POLL_MS = 8_000;
const DEFAULT_MAX_POLLS = 60;

/**
 * Bounded adaptive wait. Deterministic when callers inject the clock fns
 * (tests); production uses real timers. Only ONE scheduled timer exists at
 * any moment.
 */
export function waitUntil(options: WaitOptions): Promise<WaitResult> {
  const setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const nowFn = options.now ?? Date.now;
  const start = nowFn();
  const pollMs = Math.max(50, options.pollMs ?? DEFAULT_POLL_MS);
  const maxPollMs = Math.max(pollMs, options.maxPollMs ?? DEFAULT_MAX_POLL_MS);
  const maxPolls = options.maxPolls ?? DEFAULT_MAX_POLLS;

  return new Promise<WaitResult>((resolve) => {
    let currentPollMs = pollMs;
    let polls = 0;
    let timer: unknown = null;
    let done = false;

    const onAbort = () => {
      if (done) return;
      finish('cancelled');
    };

    const finish = (status: WaitResult['status']) => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeoutFn(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ status, polls, elapsedMs: nowFn() - start });
    };

    const evaluate = async (): Promise<void> => {
      if (done) return;
      if (options.signal?.aborted) {
        finish('cancelled');
        return;
      }
      if (nowFn() - start > options.timeoutMs || polls >= maxPolls) {
        finish('timeout');
        return;
      }
      polls += 1;
      let satisfied = false;
      try {
        satisfied = await options.check();
      } catch {
        satisfied = false; // a failing check is "not satisfied yet" — bounded by timeout
      }
      if (done) return;
      if (satisfied === true) {
        finish('satisfied');
        return;
      }
      // Adaptive backoff: double the interval up to the max.
      currentPollMs = Math.min(currentPollMs * 2, maxPollMs);
      timer = setTimeoutFn(() => void evaluate(), currentPollMs);
    };

    options.signal?.addEventListener('abort', onAbort, { once: true });
    void evaluate();
  });
}
