/**
 * Security Situation Awareness (Phase E.4).
 *
 * A read-only, on-demand view of security-relevant dependency health and
 * state. Every component is reported by its OWN subsystem (injected
 * getters); a getter that throws or reports nothing becomes an explicit
 * UNKNOWN — invented health information is impossible by construction.
 *
 * NO CONTROL SURFACE: nothing here mutates state, and nothing here can
 * bypass the Phase C gate, the Phase D.4 authority gate, or the E-stop.
 * Bounded cost: getters are cached in-memory reads (engine/monitor health,
 * E5 stop snapshot); Defender availability comes ONLY from a rate-limited
 * explicit check (never polled) — otherwise UNKNOWN.
 */
import type { SecurityEventIntel } from './intel';
import type { ThreatAssessment } from './assessment';

export type ComponentState = 'OK' | 'DEGRADED' | 'FAILED' | 'UNKNOWN';

export interface SituationComponent {
  state: ComponentState;
  detail: Record<string, unknown>;
  /** When the underlying subsystem reported this (never invented). */
  at: number;
}

export interface SecuritySituationView {
  at: number;
  monitor: SituationComponent;
  detection: SituationComponent;
  defender: SituationComponent;
  e5: SituationComponent;
  stop: SituationComponent;
  execGate: SituationComponent;
  containment: SituationComponent;
  lpv: SituationComponent;
  /** Active assessments (from E.3, computed on demand). */
  activeAssessments: ThreatAssessment[];
  /** Unresolved security events currently retained (bounded ring). */
  unresolvedEvents: number;
  eventStats: ReturnType<SecurityEventIntel['stats']>;
  /** Recent security decisions — bounded, metadata-only. */
  recentDecisions: Array<{
    id: string;
    category: string;
    kind: string;
    decision?: string;
    at: number;
    sourceTimestamp: boolean;
  }>;
}

/** Explicit defender rate limit: availability is only refreshed on an
 *  explicit, bounded check (never polled — no WMI/PowerShell loops). */
const DEFENDER_RECHECK_MIN_INTERVAL_MS = 5 * 60_000;

/** Loose structural shapes for injected subsystem getters (the wiring site
 *  casts subsystem interfaces to these — the intelligence layer only reads
 *  the named fields and invents nothing else). */
export interface MonitorStatusLike {
  health: string;
  healthReason?: string | null;
  eventsReceived?: number;
  eventsDropped?: number;
  pidReuses?: number;
}
export interface DetectionHealthLike {
  health: string;
  monitorHealth?: string | null;
  classificationCount?: number;
  queueDropped?: number;
}
export interface ExecGateHealthLike {
  health: string;
  pendingApprovals?: number | null;
}
export interface StopSnapshotLike {
  kind: string;
  generation?: number | null;
}
export interface E5StorageLike {
  protection: string;
  auditDegraded?: boolean;
}
export interface ContainmentAuthorityLike {
  approvalAuthority: string;
  pendingTokens: number;
}
export interface LpvStatusLike {
  state: string;
  tampered?: boolean;
  verified?: boolean;
}

export interface SituationSources {
  /** Phase A monitor status snapshot (sync, in-memory). */
  monitorStatus: () => MonitorStatusLike;
  /** Phase B engine health (sync, in-memory). */
  detectionHealth: () => DetectionHealthLike;
  /** Phase C gate health (sync, in-memory). */
  execGateHealth: () => ExecGateHealthLike;
  /** E5 stop snapshot (sync, in-memory, authoritative). */
  stopSnapshot: () => StopSnapshotLike;
  /** E5 storage protection info. */
  e5Storage: () => E5StorageLike;
  /** Containment availability (D.4: approval authority is unavailable in
   *  production — reported verbatim, never upgraded). */
  containmentAuthority: () => ContainmentAuthorityLike;
  /** LPV status (optional — absent becomes UNKNOWN, never invented). */
  lpvStatus?: () => LpvStatusLike | null;
  /** Explicit, rate-limited Defender availability check (async). */
  refreshDefenderAvailability?: () => Promise<{ available: boolean; detail?: Record<string, unknown> }>;
  activeAssessments: () => ThreatAssessment[];
  intel: SecurityEventIntel;
}

interface DefenderCache {
  state: ComponentState;
  detail: Record<string, unknown>;
  at: number;
  lastCheckAt: number | null;
}

export class SecuritySituation {
  private defender: DefenderCache = { state: 'UNKNOWN', detail: { reason: 'never checked — use the explicit rate-limited recheck' }, at: 0, lastCheckAt: null };
  private inflightDefender: Promise<void> | null = null;

  constructor(private readonly sources: SituationSources) {}

  getSituation(): SecuritySituationView {
    const now = Date.now();
    return {
      at: now,
      monitor: this.wrap(() => {
        const s = this.sources.monitorStatus();
        const health = String(s.health ?? 'UNKNOWN').toUpperCase();
        return {
          state: health === 'ACTIVE' ? 'OK' : health === 'STARTING' ? 'UNKNOWN' : health === 'DEGRADED' ? 'DEGRADED' : 'FAILED',
          detail: { health, healthReason: s.healthReason ?? null, eventsReceived: s.eventsReceived ?? null, eventsDropped: s.eventsDropped ?? null, pidReuses: s.pidReuses ?? null },
        };
      }),
      detection: this.wrap(() => {
        const h = this.sources.detectionHealth();
        const health = String(h.health ?? 'UNKNOWN').toUpperCase();
        return {
          state: health === 'ACTIVE' ? 'OK' : health === 'DEGRADED' ? 'DEGRADED' : health === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED',
          detail: { health, monitorHealth: h.monitorHealth ?? null, classificationCount: h.classificationCount ?? null, queueDropped: h.queueDropped ?? null },
        };
      }),
      defender: {
        state: this.defender.state,
        detail: { ...this.defender.detail, lastCheckAt: this.defender.lastCheckAt, note: 'availability is only refreshed via the explicit rate-limited check — it is never polled and never assumed' },
        at: this.defender.at,
      },
      e5: this.wrap(() => {
        const s = this.sources.e5Storage();
        const protection = String(s.protection ?? 'unknown').toLowerCase();
        return {
          state: protection === 'full' ? (s.auditDegraded ? 'DEGRADED' : 'OK') : protection === 'degraded' ? 'DEGRADED' : 'FAILED',
          detail: { protection, auditDegraded: s.auditDegraded ?? null },
        };
      }),
      stop: this.wrap(() => {
        const s = this.sources.stopSnapshot();
        const kind = String(s.kind ?? 'ACTIVE_UNCERTAIN');
        return {
          state: kind === 'INACTIVE' ? 'OK' : kind === 'ACTIVE_UNCERTAIN' ? 'UNKNOWN' : 'FAILED',
          detail: { stopKind: kind, generation: s.generation ?? null, note: kind !== 'INACTIVE' ? 'emergency stop active or uncertain — authorization-requiring actions are refused' : null },
        };
      }),
      execGate: this.wrap(() => {
        const h = this.sources.execGateHealth();
        const health = String(h.health ?? 'UNKNOWN').toUpperCase();
        return {
          state: health === 'ACTIVE' ? 'OK' : health === 'UNKNOWN' ? 'UNKNOWN' : health === 'DEGRADED' ? 'DEGRADED' : 'FAILED',
          detail: { health, pendingApprovals: h.pendingApprovals ?? null },
        };
      }),
      containment: this.wrap(() => {
        const c = this.sources.containmentAuthority();
        return {
          state: 'OK',
          detail: { approvalAuthority: c.approvalAuthority, pendingTokens: c.pendingTokens, terminationEnabled: false, note: 'termination is unreachable in production (Phase D.4) — this is a read-only intelligence surface' },
        };
      }),
      lpv: this.sources.lpvStatus
        ? this.wrap(() => {
            const s = this.sources.lpvStatus!();
            if (!s) return { state: 'UNKNOWN' as ComponentState, detail: { reason: 'LPV status unavailable' } };
            const state = String(s.state ?? 'UNKNOWN').toUpperCase();
            return {
              state: state === 'UNAVAILABLE' ? 'FAILED' : state === 'TAMPERED' ? 'FAILED' : state === 'UNKNOWN' ? 'UNKNOWN' : state === 'LOCKED' ? 'OK' : 'OK',
              detail: { vaultState: state, tampered: s.tampered ?? false },
            };
          })
        : { state: 'UNKNOWN', detail: { reason: 'LPV status source not wired — absence is not safety' }, at: now },
      activeAssessments: this.sources.activeAssessments(),
      unresolvedEvents: this.sources.intel.size(),
      eventStats: this.sources.intel.stats(),
      recentDecisions: this.sources.intel.recent(20).map((e) => ({
        id: e.id,
        category: e.category,
        kind: e.provenance.originalKind,
        decision: e.subject.decision,
        at: e.observedTimestamp ? e.observedAt : e.ingestedAt,
        sourceTimestamp: e.observedTimestamp,
      })),
    };
  }

  /** Explicit Defender availability recheck — rate-limited (5 min), never
   *  polled. While a check runs, callers get the cached (possibly UNKNOWN)
   *  value; the result updates the cache and is reported honestly. */
  recheckDefender(): { started: boolean; state: ComponentState; lastCheckAt: number | null } {
    const now = Date.now();
    if (this.sources.refreshDefenderAvailability
      && !this.inflightDefender
      && (this.defender.lastCheckAt === null || now - this.defender.lastCheckAt >= DEFENDER_RECHECK_MIN_INTERVAL_MS)) {
      this.defender.lastCheckAt = now;
      this.inflightDefender = this.sources.refreshDefenderAvailability()
        .then((result) => {
          this.defender = {
            state: result.available ? 'OK' : 'DEGRADED',
            detail: { available: result.available, ...(result.detail ?? {}) },
            at: Date.now(),
            lastCheckAt: this.defender.lastCheckAt,
          };
        })
        .catch((err) => {
          this.defender = {
            state: 'UNKNOWN',
            detail: { reason: `defender check failed: ${String((err as Error)?.message || err)}` },
            at: Date.now(),
            lastCheckAt: this.defender.lastCheckAt,
          };
        })
        .finally(() => { this.inflightDefender = null; });
      return { started: true, state: this.defender.state, lastCheckAt: this.defender.lastCheckAt };
    }
    return { started: false, state: this.defender.state, lastCheckAt: this.defender.lastCheckAt };
  }

  /** Wrapper: a throwing getter becomes an explicit UNKNOWN — never a crash,
   *  never an invented value. */
  private wrap(fn: () => { state: ComponentState; detail: Record<string, unknown> }): SituationComponent {
    try {
      const r = fn();
      return { state: r.state, detail: r.detail, at: Date.now() };
    } catch (err) {
      return {
        state: 'UNKNOWN',
        detail: { reason: `source unavailable: ${String((err as Error)?.message || err)}` },
        at: Date.now(),
      };
    }
  }
}
