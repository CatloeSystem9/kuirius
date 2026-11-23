/**
 * Cross-Event Correlation (Phase E.2).
 *
 * Identifies relationships between NORMALIZED security events using
 * EVIDENCE ONLY. Every correlation result carries the ids of the events it
 * is built from (provenance preserved end-to-end) and declares whether it
 * rests on direct evidence (events about the same subject, causally
 * ordered) or statistical association (co-occurrence only).
 *
 * HARD CONSTRAINTS:
 *  - Correlation NEVER classifies. It emits severity/confidence HINTS; the
 *    assessment layer (E.3) decides, and Phase B classification precedence
 *    is untouched. UNKNOWN detections are never promoted by correlation.
 *  - Process names alone are never evidence of malice: every rule requires
 *    at least one non-name signal (a Defender-backed detection, a gate
 *    decision, a containment refusal, a stop transition). Legitimate
 *    dual-use tools that merely run many times produce NO correlation.
 *  - Events without source timestamps (observedAt === 0) cannot anchor a
 *    time-window rule; they participate only in same-subject adjacency.
 *  - Time windows are bounded; stale events are excluded by observedAt.
 */
import type { SecurityEvent } from './eventTypes';
import type { SecurityEventIntel } from './intel';

export interface CorrelationWindows {
  /** Process creation followed by a detection of the same subject. */
  processDetectionMs?: number;
  /** Repetition window for repeated-execution / repeated-denial rules. */
  repeatWindowMs?: number;
  /** Adjacency window around an E-stop transition. */
  stopWindowMs?: number;
  /** Events older than this (relative to `now`) are stale and excluded. */
  maxEventAgeMs?: number;
}

export interface CorrelationResult {
  ruleId: string;
  title: string;
  description: string;
  /** Subject reference (pid/name/path when the rule's evidence provides it). */
  subject: { pid?: number; name?: string; executablePath?: string };
  /** Ids of the normalized events that constitute the evidence (provenance). */
  evidenceEventIds: string[];
  /** How the evidence was ordered/found. */
  windowMs: number;
  /** true = events about the same subject in causal order; false = co-occurrence. */
  directEvidence: boolean;
  /** true = built from repetition/co-occurrence only (not causal ordering). */
  statisticalOnly: boolean;
  /** Hints for the assessment layer (E.3 decides; correlation never classifies). */
  severityHint: 'INFORMATIONAL' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  confidenceHint: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';
  at: number;
}

const DEFAULTS: Required<CorrelationWindows> = {
  processDetectionMs: 30_000,
  repeatWindowMs: 10 * 60_000,
  stopWindowMs: 60_000,
  maxEventAgeMs: 60 * 60_000,
};

const MAX_RESULTS = 50;
const MAX_EVIDENCE_PER_RULE = 20;

type Severity = CorrelationResult['severityHint'];
type Confidence = CorrelationResult['confidenceHint'];

const SEVERITY_ORDER: Record<Severity, number> = { INFORMATIONAL: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

function subjectOf(event: SecurityEvent): { pid?: number; name?: string; executablePath?: string } {
  const subject: { pid?: number; name?: string; executablePath?: string } = {};
  if (event.subject.pid !== undefined) subject.pid = event.subject.pid;
  if (event.subject.name) subject.name = event.subject.name;
  if (event.subject.executablePath) subject.executablePath = event.subject.executablePath;
  return subject;
}

function sameSubject(a: SecurityEvent, b: SecurityEvent): boolean {
  if (a.subject.pid !== undefined && b.subject.pid !== undefined) {
    if (a.subject.pid === b.subject.pid) return true;
  }
  if (a.subject.executablePath && b.subject.executablePath) {
    return a.subject.executablePath.toLowerCase() === b.subject.executablePath.toLowerCase();
  }
  if (a.subject.name && b.subject.name) {
    return a.subject.name.toLowerCase() === b.subject.name.toLowerCase();
  }
  return false;
}

export class CorrelationEngine {
  private readonly windows: Required<CorrelationWindows>;
  private readonly now: () => number;

  constructor(windows: CorrelationWindows = {}, now: () => number = Date.now) {
    this.windows = { ...DEFAULTS, ...windows };
    this.now = now;
  }

  /** Run all correlation rules over the intel ring. Deterministic; bounded
   *  output. Cheap enough to run on demand (per read), not on a timer. */
  correlate(intel: SecurityEventIntel): CorrelationResult[] {
    const now = this.now();
    const events = intel.events().filter((e) => {
      // Stale exclusion applies only to events WITH source timestamps;
      // time-less events are skipped by time-window rules themselves.
      if (e.observedTimestamp) return now - e.observedAt <= this.windows.maxEventAgeMs;
      return now - e.ingestedAt <= this.windows.maxEventAgeMs;
    });
    const results: CorrelationResult[] = [];

    const byCategory = (c: SecurityEvent['category']) => events.filter((e) => e.category === c);
    const detections = byCategory('detection');
    const gateBlocks = byCategory('exec_gate').filter((e) => {
      const d = (e.subject.decision ?? '').toUpperCase();
      return d === 'BLOCK' || d === 'REQUIRE_APPROVAL' || d === 'DENY' || d === 'BLOCK_SYSTEM_UNAVAILABLE';
    });
    const processCreates = byCategory('process').filter((e) => e.provenance.originalKind === 'process_create');
    const containment = byCategory('containment');
    const stopTransitions = byCategory('stop').filter((e) => e.provenance.originalKind !== 'e5_stop_blocked');
    const monitorHealth = byCategory('monitor_health').filter((e) => {
      const k = e.provenance.originalKind.toLowerCase();
      return k.includes('degraded') || k.includes('failed');
    });

    // R1 — process creation followed by a Defender-backed detection of the
    // same subject (direct evidence: same subject, causal order).
    for (const detection of detections) {
      const cls = (detection.subject.classification ?? '').toUpperCase();
      if (cls !== 'SUSPICIOUS' && cls !== 'HIGH_CONFIDENCE_THREAT' && cls !== 'CONFIRMED_MALWARE') continue;
      if (!detection.observedTimestamp) continue;
      const prior = processCreates
        .filter((c) => c.observedTimestamp && c.observedAt <= detection.observedAt)
        .filter((c) => detection.observedAt - c.observedAt <= this.windows.processDetectionMs)
        .filter((c) => sameSubject(c, detection))
        .sort((a, b) => b.observedAt - a.observedAt);
      if (prior.length === 0) continue;
      results.push({
        ruleId: 'R1_process_then_detection',
        title: 'Process creation followed by a malware-classification detection',
        description: `A process creation event was followed within ${this.windows.processDetectionMs} ms by a ${cls} detection of the same subject (evidence-linked by monitor and detection records).`,
        subject: subjectOf(detection),
        evidenceEventIds: [prior[0].id, detection.id],
        windowMs: this.windows.processDetectionMs,
        directEvidence: true,
        statisticalOnly: false,
        severityHint: cls === 'CONFIRMED_MALWARE' ? 'CRITICAL' : cls === 'HIGH_CONFIDENCE_THREAT' ? 'HIGH' : 'MEDIUM',
        confidenceHint: 'HIGH',
        at: now,
      });
    }

    // R2 — repeated suspicious execution attempts for the same path
    // (statistical association: repetition is not causal ordering).
    const gateByPath = new Map<string, SecurityEvent[]>();
    for (const b of gateBlocks) {
      const key = (b.subject.executablePath ?? b.subject.name ?? '').toLowerCase();
      if (!key) continue;
      const list = gateByPath.get(key) ?? [];
      list.push(b);
      gateByPath.set(key, list);
    }
    for (const [key, list] of gateByPath) {
      if (list.length < 3) continue;
      const sorted = list.sort((a, b) => anchorOf(a) - anchorOf(b));
      const last = sorted[sorted.length - 1];
      const windowList = sorted.filter((e) => anchorOf(last) - anchorOf(e) <= this.windows.repeatWindowMs);
      if (windowList.length < 3) continue;
      results.push({
        ruleId: 'R2_repeated_execution_attempts',
        title: 'Repeated suspicious execution attempts for the same executable',
        description: `${windowList.length} execution-gate refusals/holds for the same executable within ${this.windows.repeatWindowMs} ms (statistical association — repetition, not causal ordering).`,
        subject: subjectOf(last),
        evidenceEventIds: windowList.slice(-MAX_EVIDENCE_PER_RULE).map((e) => e.id),
        windowMs: this.windows.repeatWindowMs,
        directEvidence: false,
        statisticalOnly: true,
        severityHint: windowList.length >= 5 ? 'HIGH' : 'MEDIUM',
        confidenceHint: 'MEDIUM',
        at: now,
      });
      void key;
    }

    // R3 — one subject associated with multiple DISTINCT suspicious signal
    // categories (detection + gate refusal + containment attempt). Subjects
    // are grouped by ANY shared identity dimension (path, pid, or name) via
    // a small union-find — the same subject may be keyed differently by
    // different subsystems (e.g. a detection carries a pid, a gate refusal
    // carries only the path).
    const suspicious = [...detections, ...gateBlocks, ...containment];
    const parent = new Map<SecurityEvent, SecurityEvent>();
    const find = (e: SecurityEvent): SecurityEvent => {
      let root = e;
      while (parent.get(root) !== root) root = parent.get(root)!;
      const cur = e;
      while (parent.get(cur) !== root) parent.set(cur, root);
      return root;
    };
    for (const e of suspicious) parent.set(e, e);
    const byDimension = new Map<string, SecurityEvent>();
    for (const e of suspicious) {
      const dims = [e.subject.executablePath?.toLowerCase(), e.subject.pid !== undefined ? `pid:${e.subject.pid}` : undefined, e.subject.name?.toLowerCase()]
        .filter((d): d is string => !!d);
      for (const d of dims) {
        const existing = byDimension.get(d);
        if (existing) {
          const a = find(existing);
          const b = find(e);
          if (a !== b) parent.set(a, b);
        } else {
          byDimension.set(d, e);
        }
      }
    }
    const groups = new Map<SecurityEvent, SecurityEvent[]>();
    for (const e of suspicious) {
      const root = find(e);
      const list = groups.get(root) ?? [];
      list.push(e);
      groups.set(root, list);
    }
    for (const [, list] of groups) {
      const categories = new Set(list.map((e) => e.category));
      if (categories.size < 2) continue;
      const sorted = list.sort((a, b) => anchorOf(a) - anchorOf(b));
      const hasConfirmed = list.some((e) => (e.subject.classification ?? '').toUpperCase() === 'CONFIRMED_MALWARE');
      results.push({
        ruleId: 'R3_multi_indicator_subject',
        title: 'One subject associated with multiple suspicious signal categories',
        description: `The same subject appears across ${[...categories].sort().join(' + ')} events (${list.length} records) — convergent evidence from independent subsystems.`,
        subject: subjectOf(sorted[sorted.length - 1]),
        evidenceEventIds: sorted.slice(-MAX_EVIDENCE_PER_RULE).map((e) => e.id),
        windowMs: this.windows.repeatWindowMs,
        directEvidence: true,
        statisticalOnly: false,
        severityHint: hasConfirmed ? 'CRITICAL' : 'HIGH',
        confidenceHint: 'HIGH',
        at: now,
      });
    }

    // R4 — executable identity change / PID-reuse signals from containment
    // refusals (direct evidence: the refusal states the mismatch).
    for (const c of containment) {
      const k = (c.provenance.originalKind + ' ' + (c.subject.decision ?? '')).toUpperCase();
      if (!k.includes('REFUSED_PID_REUSED') && !k.includes('REFUSED_IDENTITY_CHANGED')) continue;
      results.push({
        ruleId: 'R4_identity_change',
        title: 'Executable identity change or PID reuse detected',
        description: 'A containment identity verification refused a subject because its creation time or executable path changed — the identity is not the one that was assessed.',
        subject: subjectOf(c),
        evidenceEventIds: [c.id],
        windowMs: 0,
        directEvidence: true,
        statisticalOnly: false,
        severityHint: 'MEDIUM',
        confidenceHint: 'HIGH',
        at: now,
      });
    }

    // R5 — security-monitor degradation followed by suspicious activity
    // (direct evidence of degraded visibility + a later signal).
    for (const h of monitorHealth) {
      const anchor = anchorOf(h);
      const later = [...detections, ...gateBlocks]
        .filter((e) => anchorOf(e) >= anchor && anchorOf(e) - anchor <= this.windows.repeatWindowMs);
      if (later.length === 0) continue;
      results.push({
        ruleId: 'R5_degraded_visibility_then_activity',
        title: 'Suspicious activity observed while security monitoring was degraded',
        description: `A monitor-health degradation (${h.provenance.originalKind}) was followed by ${later.length} suspicious signal(s) within ${this.windows.repeatWindowMs} ms — visibility was incomplete when the signals arrived.`,
        subject: subjectOf(later[later.length - 1]),
        evidenceEventIds: [h.id, ...later.slice(0, 3).map((e) => e.id)],
        windowMs: this.windows.repeatWindowMs,
        directEvidence: false,
        statisticalOnly: true,
        severityHint: 'MEDIUM',
        confidenceHint: 'LOW',
        at: now,
      });
    }

    // R6 — repeated access-denied containment attempts (direct evidence).
    const denied = containment.filter((c) => (c.subject.decision ?? '').toUpperCase().includes('ACCESS_DENIED') || (c.subject.decision ?? '').toUpperCase().includes('IDENTITY_NOT_GUARANTEED'));
    if (denied.length >= 2) {
      const sorted = denied.sort((a, b) => anchorOf(a) - anchorOf(b));
      results.push({
        ruleId: 'R6_repeated_access_denied',
        title: 'Repeated access-denied containment attempts',
        description: `${denied.length} containment attempts ended in access-denied/identity-not-guaranteed — a subject may be protected or elevated, or the attempts are misdirected.`,
        subject: subjectOf(sorted[sorted.length - 1]),
        evidenceEventIds: sorted.slice(-MAX_EVIDENCE_PER_RULE).map((e) => e.id),
        windowMs: this.windows.repeatWindowMs,
        directEvidence: true,
        statisticalOnly: false,
        severityHint: 'LOW',
        confidenceHint: 'MEDIUM',
        at: now,
      });
    }

    // R7 — security events adjacent to an E-stop transition (temporal
    // association only — correlation must not imply causation).
    for (const t of stopTransitions) {
      const anchor = anchorOf(t);
      const adjacent = events.filter((e) => e.id !== t.id
        && e.category !== 'stop'
        && Math.abs(anchorOf(e) - anchor) <= this.windows.stopWindowMs);
      if (adjacent.length < 2) continue;
      results.push({
        ruleId: 'R7_estop_adjacency',
        title: 'Security events clustered around an E-stop transition',
        description: `${adjacent.length} security event(s) occurred within ±${this.windows.stopWindowMs} ms of an E-stop transition (${t.provenance.originalKind}) — temporal association only.`,
        subject: subjectOf(t),
        evidenceEventIds: [t.id, ...adjacent.slice(0, 5).map((e) => e.id)],
        windowMs: this.windows.stopWindowMs * 2,
        directEvidence: false,
        statisticalOnly: true,
        severityHint: 'INFORMATIONAL',
        confidenceHint: 'LOW',
        at: now,
      });
    }

    // Deduplicate by rule+subject (one result per rule per subject) and cap.
    const seen = new Set<string>();
    const unique = results.filter((r) => {
      const key = `${r.ruleId}|${r.subject.pid ?? '-'}|${(r.subject.executablePath ?? r.subject.name ?? '-').toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return unique
      .sort((a, b) => SEVERITY_ORDER[b.severityHint] - SEVERITY_ORDER[a.severityHint])
      .slice(0, MAX_RESULTS);
  }
}

/** Time anchor for window math: source timestamp when present (honest),
 *  ingestion time otherwise (marked as such by the event's
 *  observedTimestamp flag — rules skip time-less events where ordering
 *  matters, but repetition rules tolerate ingestion-time anchoring). */
function anchorOf(event: SecurityEvent): number {
  return event.observedTimestamp ? event.observedAt : event.ingestedAt;
}
