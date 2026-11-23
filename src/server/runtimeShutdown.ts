/**
 * Runtime shutdown (Step 1 — Background Runtime).
 *
 * Graceful termination for the Krix server process: on SIGINT/SIGTERM the
 * HTTP listener closes and every spawned child (PowerShell worker, process
 * monitor, malware engine subscriptions) is stopped deterministically
 * instead of relying on their self-exit probes. Windows sleep is NOT a
 * signal — the process simply freezes and resumes unchanged, so sleep
 * requires no shutdown handling. Extracted into a module so the sequence is
 * unit-testable without booting Express (process.emit('SIGINT')).
 */

export interface GracefulShutdownOptions {
  /** Teardown of server-owned children/listeners (worker, monitors). */
  onStop: () => void;
  /** Log sink (default console.log). */
  log?: (msg: string) => void;
  /** Injectable exit (tests) — defaults to process.exit(0). */
  exit?: (code: number) => void;
  /** Signals to handle (default SIGINT + SIGTERM). */
  signals?: NodeJS.Signals[];
}

export function installGracefulShutdown(options: GracefulShutdownOptions): void {
  const signals: NodeJS.Signals[] = options.signals ?? ['SIGINT', 'SIGTERM'];
  const log = options.log ?? ((msg: string) => console.log(msg));
  const exit = options.exit ?? ((code: number) => process.exit(code));

  let shuttingDown = false;
  for (const signal of signals) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      log(`[runtime] ${signal} received — shutting down Krix server gracefully`);
      try {
        options.onStop();
      } catch {
        // every stoppable child owns its own guards; teardown is best-effort
      }
      exit(0);
    });
  }
}
