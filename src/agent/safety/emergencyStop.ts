/**
 * Emergency stop (Phase 18, spec §9) — connects the existing cancellation
 * architecture (AgentCore.cancelAll / AbortSignals) to a safety-level stop:
 * active tasks are cancelled, temporary permissions are revoked, and the
 * central gate blocks new SIDE-EFFECTING actions until resume. Read-only,
 * local work continues; the system stays fully recoverable.
 */
import type { SafetyAuditLog } from './auditLog';

export class EmergencyStop {
  private active = false;
  private reason: string | null = null;
  private activatedAt: number | null = null;
  private hooks: ((reason: string) => void)[] = [];

  constructor(private audit?: SafetyAuditLog) {}

  /** Register a side-effect-free reaction (e.g. bridge: core.cancelAll() + revoke temporary grants). */
  onActivate(hook: (reason: string) => void): void {
    this.hooks.push(hook);
  }

  activate(reason: string): { active: boolean; reason: string } {
    if (this.active) return { active: true, reason: this.reason ?? '' };
    this.active = true;
    this.reason = String(reason ?? 'emergency stop').slice(0, 160);
    this.activatedAt = Date.now();
    this.audit?.append({ kind: 'emergency_stop', reason: this.reason });
    for (const hook of this.hooks) {
      try {
        hook(this.reason);
      } catch {
        // a stop hook must never prevent the stop itself
      }
    }
    return { active: true, reason: this.reason };
  }

  /** Resume: clears the stop so normal (permission-checked) work continues. */
  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    const reason = this.reason;
    this.reason = null;
    this.activatedAt = null;
    this.audit?.append({ kind: 'emergency_resume', reason: `resumed after: ${reason ?? 'stop'}` });
  }

  isActive(): boolean {
    return this.active;
  }

  status(): { active: boolean; reason: string | null; activatedAt: number | null } {
    return { active: this.active, reason: this.reason, activatedAt: this.activatedAt };
  }
}
