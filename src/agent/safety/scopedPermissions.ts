/**
 * Scoped permissions (Phase 18, spec §5/§7/§8) — explicit, expiring,
 * revocable grants layered ON TOP of the existing session-level
 * PermissionManager (whose session-wide booleans remain the documented base
 * layer of the existing architecture). A scoped grant never widens the base
 * layer: the gate requires BOTH the base permission (granted or absent-by-
 * default rules) and an applicable scoped grant when one exists for the
 * capability.
 */
import type { GrantScope, ScopedGrant } from './safetyTypes';
import { describeScope } from './safetyTypes';

export type ScopedCheckResult =
  | { status: 'absent' }
  | { status: 'granted'; grant: ScopedGrant }
  | { status: 'expired'; grant: ScopedGrant }
  | { status: 'exhausted'; grant: ScopedGrant }
  | { status: 'revoked' };

export interface GrantInput {
  permission: string;
  scope: GrantScope;
  reason: string;
  temporary?: boolean;
  now?: number;
}

const MAX_GRANTS = 64;

export class ScopedPermissionManager {
  private grants = new Map<string, ScopedGrant>();
  private revoked = new Set<string>(); // revoked capability names (this layer)
  private seq = 0;

  constructor(private now: () => number = Date.now) {}

  /** Grant a scoped authorization. One-shot grants are consumed on use. */
  grant(input: GrantInput): ScopedGrant {
    if (this.grants.size >= MAX_GRANTS) {
      // Evolve: drop the oldest temporary grant to stay bounded.
      const oldest = [...this.grants.values()].find((g) => g.temporary) ?? [...this.grants.values()][0];
      if (oldest) this.grants.delete(oldest.id);
    }
    this.seq += 1;
    const grant: ScopedGrant = {
      id: `grant_${this.now()}_${this.seq}`,
      permission: input.permission,
      scope: input.scope,
      reason: input.reason.slice(0, 160),
      grantedAt: input.now ?? this.now(),
      temporary: input.temporary ?? input.scope.kind !== 'session',
    };
    this.grants.set(grant.id, grant);
    this.revoked.delete(input.permission);
    return grant;
  }

  /**
   * Check + CONSUME applicability: one-shot grants are marked used here so
   * "once" truly means once (checked by the central gate before execution).
   */
  check(permission: string, context?: { taskId?: string }): ScopedCheckResult {
    if (this.revoked.has(permission)) return { status: 'revoked' };

    let best: ScopedGrant | null = null;
    for (const grant of this.grants.values()) {
      if (grant.permission !== permission) continue;
      if (grant.scope.kind === 'task' && context?.taskId && grant.scope.taskId === context.taskId) {
        best = grant;
        break;
      }
      if (grant.scope.kind !== 'task') {
        best = grant;
        break;
      }
    }
    if (!best) return { status: 'absent' };

    if (best.scope.kind === 'duration' && this.now() >= best.scope.expiresAt) {
      this.grants.delete(best.id); // expired authorization is removed, never reused
      return { status: 'expired', grant: best };
    }
    if (best.scope.kind === 'once') {
      this.grants.delete(best.id); // consumed — the next call must ask again
      return { status: 'granted', grant: best };
    }
    return { status: 'granted', grant: best };
  }

  /** Immediately prevent all future actions under one capability — a
   *  kill-switch that overrides even session-level base grants until an
   *  explicit new grant is made. */
  revoke(permission: string): number {
    this.revoked.add(permission);
    let removed = 0;
    for (const [id, grant] of [...this.grants.entries()]) {
      if (grant.permission === permission) {
        this.grants.delete(id);
        removed++;
      }
    }
    return removed;
  }

  isRevoked(permission: string): boolean {
    return this.revoked.has(permission);
  }

  /** Emergency stop: revoke every temporary/derived grant, keep nothing stale. */
  revokeAllTemporary(): number {
    let removed = 0;
    for (const [id, grant] of [...this.grants.entries()]) {
      if (grant.temporary) {
        this.grants.delete(id);
        removed++;
      }
    }
    return removed;
  }

  list(): (ScopedGrant & { scopeText: string })[] {
    return [...this.grants.values()].map((g) => ({ ...g, scopeText: describeScope(g.scope) }));
  }

  count(): number {
    return this.grants.size;
  }
}
