/**
 * Security intelligence agent tools (Phase E).
 *
 * TWO read-only visibility tools backed by read-only server routes. NO
 * control surface exists: these tools cannot terminate, quarantine, modify
 * Defender, restrict operations, or influence any authorization decision —
 * they only read the intelligence layer's view. Recommendations surfaced
 * here are explicitly labeled non-actionable through the intelligence layer
 * (Phase D.4 keeps termination unreachable; the E-stop remains the only
 * restriction mechanism and is never invoked by these tools).
 */
import type { AgentTool, ToolResult } from '../types';
import { ok, fail } from '../types';

interface SituationResponse {
  monitor?: { state: string; detail?: Record<string, unknown> };
  detection?: { state: string; detail?: Record<string, unknown> };
  defender?: { state: string; detail?: Record<string, unknown> };
  e5?: { state: string; detail?: Record<string, unknown> };
  stop?: { state: string; detail?: Record<string, unknown> };
  execGate?: { state: string; detail?: Record<string, unknown> };
  containment?: { state: string; detail?: Record<string, unknown> };
  lpv?: { state: string; detail?: Record<string, unknown> };
  activeAssessments?: Array<{ id: string; severity: string; confidenceLabel: string; kind: string; reason: string; recommendedNextAction: string; humanReviewRequired: boolean }>;
  unresolvedEvents?: number;
  eventStats?: Record<string, unknown>;
  error?: string;
}

export function createSecurityIntelTools(): AgentTool[] {
  return [
    {
      name: 'securityIntel.status',
      description:
        'Read-only security situation awareness: health of the process monitor, malware detection, Defender availability, E5 protection, emergency-stop state, execution gate, containment availability (termination is disabled in production), and LPV state, plus bounded recent security decisions. Read-only — cannot modify any state or invoke any control.',
      category: 'system',
      riskLevel: 'safe',
      cost: 'free',
      reliability: 1.0,
      capabilities: ['securityIntel.status', 'system.health'],
      permissions: [],
      inputSchema: {
        optional: ['recheckDefender'],
        types: { recheckDefender: 'boolean' },
      },
      verification: {
        strategy: 'self_reported',
        description: 'Reports each subsystem\'s own health verbatim; unavailable sources appear as UNKNOWN, never as healthy.',
      },
      async execute(input): Promise<ToolResult> {
        const recheck = input?.recheckDefender === true;
        try {
          const res = await fetch(`/api/security/situation${recheck ? '?recheckDefender=1' : ''}`);
          const data = (await res.json()) as SituationResponse;
          if (data?.error) return fail(`security intelligence unavailable: ${data.error}`, { errorKind: 'not_found' });
          const stop = data.stop ?? { state: 'UNKNOWN' };
          return ok({
            output: {
              monitor: data.monitor?.state ?? 'UNKNOWN',
              detection: data.detection?.state ?? 'UNKNOWN',
              defender: data.defender?.state ?? 'UNKNOWN',
              e5: data.e5?.state ?? 'UNKNOWN',
              emergencyStop: (stop.detail as { stopKind?: string } | undefined)?.stopKind ?? 'ACTIVE_UNCERTAIN',
              execGate: data.execGate?.state ?? 'UNKNOWN',
              containment: {
                state: data.containment?.state ?? 'UNKNOWN',
                terminationEnabled: false,
                note: 'production termination is disabled (Phase D.4 approval authority unavailable)',
              },
              lpv: data.lpv?.state ?? 'UNKNOWN',
              activeAssessments: (data.activeAssessments ?? []).map((a) => ({
                id: a.id,
                severity: a.severity,
                confidence: a.confidenceLabel,
                kind: a.kind,
                reason: a.reason,
                recommendedNextAction: a.recommendedNextAction,
                humanReviewRequired: a.humanReviewRequired,
              })),
              unresolvedEvents: data.unresolvedEvents ?? 0,
              note: 'all values are metadata observations from existing subsystems; UNKNOWN means the source could not report — absence of telemetry is never safety',
            },
          });
        } catch (err) {
          return fail(`security situation unavailable: ${String((err as Error)?.message || err)}`, { errorKind: 'not_found' });
        }
      },
    },
    {
      name: 'securityIntel.incidents',
      description:
        'Read-only incident status (Phase F): active incidents with lifecycle state, severity/confidence, evidence summary, pending operator decisions, containment outcomes, and E-stop status. Read-only — cannot create, modify, or execute anything; containment always requires the operator credential through Phase D.',
      category: 'system',
      riskLevel: 'safe',
      cost: 'free',
      reliability: 1.0,
      capabilities: ['securityIntel.incidents'],
      permissions: [],
      inputSchema: {
        optional: ['incidentId'],
        types: { incidentId: 'string' },
      },
      verification: {
        strategy: 'self_reported',
        description: 'Reports the incident store verbatim; no incident is invented or hidden.',
      },
      async execute(input): Promise<ToolResult> {
        const id = typeof input?.incidentId === 'string' ? input.incidentId : null;
        try {
          const res = await fetch(`/api/security/incidents${id ? `?id=${encodeURIComponent(id)}` : ''}`);
          const data = (await res.json()) as { incidents?: Array<Record<string, unknown>>; incident?: Record<string, unknown>; activeCount?: number; stopKind?: string; credentialEnrolled?: boolean; error?: string };
          if (data?.error) return fail(`incident status unavailable: ${data.error}`, { errorKind: 'not_found' });
          return ok({
            output: {
              stopKind: data.stopKind,
              containmentAuthorizationEnrolled: data.credentialEnrolled ?? false,
              note: 'incidents are tracked end-to-end; containment requires the operator credential through Phase D and is blocked by the E-stop',
              ...(id ? { incident: data.incident } : { activeCount: data.activeCount, incidents: data.incidents ?? [] }),
            },
          });
        } catch (err) {
          return fail(`incident status unavailable: ${String((err as Error)?.message || err)}`, { errorKind: 'not_found' });
        }
      },
    },
    {
      name: 'securityIntel.assessments',
      description:
        'Read-only list of current threat assessments (severity and confidence are separate axes; every assessment cites its evidence and is an inference unless marked confirmed-by-source). Read-only — assessments never authorize any action and CRITICAL never implies termination.',
      category: 'system',
      riskLevel: 'safe',
      cost: 'free',
      reliability: 1.0,
      capabilities: ['securityIntel.assessments'],
      permissions: [],
      inputSchema: {
        optional: [],
        types: {},
      },
      verification: {
        strategy: 'self_reported',
        description: 'Returns the assessment engine\'s current output verbatim, including contradictory evidence and missing information.',
      },
      async execute(): Promise<ToolResult> {
        try {
          const res = await fetch('/api/security/assessments');
          const data = (await res.json()) as { assessments?: Array<Record<string, unknown>>; error?: string };
          if (data?.error) return fail(`security assessments unavailable: ${data.error}`, { errorKind: 'not_found' });
          return ok({
            output: {
              assessments: (data.assessments ?? []).map((a) => ({
                id: a.id,
                kind: a.kind,
                severity: a.severity,
                confidence: a.confidence,
                confidenceLabel: a.confidenceLabel,
                subject: a.subject,
                evidenceCount: Array.isArray(a.evidenceRefs) ? (a.evidenceRefs as string[]).length : 0,
                contradictingCount: Array.isArray(a.contradictingRefs) ? (a.contradictingRefs as string[]).length : 0,
                reason: a.reason,
                missingInfo: a.missingInfo,
                recommendedNextAction: a.recommendedNextAction,
                humanReviewRequired: a.humanReviewRequired,
                sourceClassifications: a.sourceClassifications,
                note: 'assessments are inferences (or referenced source facts); they authorize nothing',
              })),
            },
          });
        } catch (err) {
          return fail(`security assessments unavailable: ${String((err as Error)?.message || err)}`, { errorKind: 'not_found' });
        }
      },
    },
  ];
}
