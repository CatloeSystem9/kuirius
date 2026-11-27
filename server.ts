import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Modality } from "@google/genai";
import dotenv from "dotenv";
// E5 M1 — server-side safety foundation: persistent emergency stop, protected
// storage, server-side permission enforcement, audit, recovery pipe. All
// initialization inside is SYNCHRONOUS and completes at import time, before
// any route below can serve a request.
import {
  createBodySizeGuard,
  enforce,
  stopSnapshot,
  activateStop,
  rateLimit,
  stopKind,
  getStorageInfo,
  auditDegraded,
  containmentApprovalCredentialSet,
  containmentApprovalEpoch,
  verifyContainmentApprovalCredential,
  serverPermissions,
  readAuditEntries,
  readLastVerifiedAuditSegment,
  verifyAuditChain,
} from "./serverSafety";
// E5 M3 — rollback planning/challenges + E7 quarantine (imported for their
// synchronous init side effects: none — they are pure consumers of the M1/M2
// stores; route handlers below use them exclusively).
import * as rollback from "./rollbackCore";
import * as quarantine from "./quarantineCore";
import { startIntegrityMonitor, lastIntegrityReport, configuredIntervalMs } from "./integrityMonitor";
import {
  CachedClassifier,
  createDefaultModelRegistry,
  getPerformanceTelemetry,
  hashKey,
  localModelEligible,
  ModelRouter,
  RequestCoalescer,
} from "./src/agent/routing";
// Context Engine v1: local-first, cache-first, network-last context selection.
// (Imported with an explicit /index specifier: './src/agent/context' already
// refers to the Phase 10 task-context helper module context.ts.)
import { ContextEngine, analyzeContext, rankItems, packWithinBudget } from "./src/agent/context/index";
import type { ContextBudgetConfig, ContextItem, StorageAdapter } from "./src/agent/context/index";
// Persistent Identity Foundation (Step 1) — Krisha's identity is ONE stable,
// validated, versioned record shared by every AI provider. The server renders
// prompts from validated STRUCTURED identity data (never pre-rendered prose);
// a missing/invalid payload fails closed toward the compiled-in canonical
// identity, so model/provider switches can never replace who she is.
import {
  CANONICAL_IDENTITY,
  normalizeIdentity,
  renderIdentityPromptBlock,
  validateIdentityTransportPayload,
} from "./src/agent/identity/index";
import type { KrishaIdentity } from "./src/agent/identity/index";
// Step 1 Background Runtime — graceful termination (Ctrl+C / service stop).
import { installGracefulShutdown } from "./src/server/runtimeShutdown";
// Screen Privacy Firewall (SPF) — mandatory, fail-closed boundary between
// screen observation and every external transmission (EP-1..EP-9 below).
import { spfFirewall, spfAuditLog, spfScreenItem } from "./src/agent/spf/index";
import type { SpfVerdict } from "./src/agent/spf/index";
// SPF VISUAL — local OCR pixel inspection + irreversible region redaction
// for every screenshot that can leave the device (Windows.Media.Ocr worker,
// zero dependencies, fully offline; fail-closed).
import { inspectImageForTransmission, screenUnderstandImage, configureSharedOcrWorker } from "./src/agent/spf/visualInspection";
import type { VisualInspectionResult } from "./src/agent/spf/visualInspection";
// SPF EP-16 — system-wide outbound transport guard: patches globalThis.fetch
// and node:http/https so NO external request can bypass the firewall by using
// another client or integration. Installed before anything can call out.
import { installSpfOutboundGuard } from "./src/agent/spf/outboundGuard";
import { appendAuditSyncSafe } from "./serverSafety";
// Approval Surface — unified operator decisions (browser card + Windows toast)
// with confidence-gated autonomy. See src/agent/approval/.
import {
  ApprovalRegistry,
  PresenceTracker,
  TrustGate,
  AUTO_APPROVABLE_ACTION_TYPES,
  DEFAULT_APPROVAL_POLICY,
  sanitizePolicy,
  type ApprovalPolicy,
} from "./src/agent/approval/index";
// Process Monitor (Phase A) — independent, event-driven host process
// visibility. Temporary session-owned WMI subscriptions (no admin, no
// permanent consumers, clean disposal on shutdown/restart), bounded
// inventory, metadata-only lifecycle audit. Visibility ONLY: no process
// control surface exists anywhere in this subsystem.
import { ProcessMonitor } from "./src/agent/processmonitor/processMonitor";
// Malware detection & classification (Phase B) — evidence correlation over
// Phase A telemetry, local file reputation, and read-only Defender data.
// Detection and classification ONLY: no process control, no quarantine, no
// blocking, no Defender configuration changes, no external reputation lookups.
import { DetectionEngine } from "./src/agent/malwaredetect/engine";
import { createDefenderSource } from "./src/agent/malwaredetect/defenderSource";
// Phase C — execution gate: centralized Krisha-managed launch decision.
// Blocks confirmed malware non-overridably; requires approval for suspicious.
import { ExecutionGate } from "./src/agent/execgate/execGate";
// Phase D.3 — threat containment: termination bound to a process-INSTANCE
// reference (OS handle pinning) so PID reuse can never redirect the signal.
// Identity and classification are established SERVER-SIDE; approval tokens
// are minted only by the containment module for CONFIRMED_MALWARE, and only
// after the OPERATOR'S APPROVAL CREDENTIAL verifies server-side (Phase D
// completion: enrollment happens through the recovery pipe — a channel with
// no model/tool path; the credential is a dedicated operator secret stored
// in the protected E5 store, distinct from the episode-scoped recovery
// credential).
import {
  ThreatContainment,
  defaultPinProcess,
  defaultReadProcessIdentity,
  createCredentialApprovalAuthority,
} from "./src/agent/containment/containment";
// Phase E — security intelligence: unified metadata events from the EXISTING
// subsystems (no new collection), evidence-linked correlation, severity/
// confidence-separated assessments, read-only situation awareness, and safe
// response recommendations. NO control surface: this layer cannot terminate,
// quarantine, modify Defender, or bypass any authorization (Phase D.4 keeps
// termination unreachable; the E-stop remains authoritative).
import {
  SecurityEventIntel,
  CorrelationEngine,
  AssessmentEngine,
  SecuritySituation,
  ResponseRecommender,
  type MonitorStatusLike,
  type DetectionHealthLike,
  type ExecGateHealthLike,
  type StopSnapshotLike,
} from "./src/agent/securityintel/index";
// Phase F — incident orchestration: coordinates Phases A-E into traceable
// incidents with a deterministic lifecycle, structured evidence, and
// authorization-aware response eligibility. Phase E stays the ONLY
// intelligence source; containment executes ONLY through Phase D (the
// operator credential, authority epoch, pinning and E-stop checks inside
// Phase D are the authority). No new classification, no new audit authority.
import { IncidentStore, IncidentOrchestrator } from "./src/agent/incidents/index";
// Initiation Subsystem — autonomous start (Scheduler + Event Triggers + Boot Resume)
import { InitiationManager } from "./src/agent/initiation/index";

const spfOutboundGuard = installSpfOutboundGuard(spfFirewall);

// Phase E.1 — unified security event intelligence over EXISTING metadata.
// Bounded ring (2000), dedup window, provenance-preserving, metadata-only.
const securityIntel = new SecurityEventIntel({ capacity: 2000 });
// Forward reference: the Phase F orchestrator is constructed after the
// subsystems it coordinates; the audit tap below drives it event-driven.
let incidentOrchestratorRef: { scheduleProcessing(): void; sweepStopTransition(): void } | null = null;
const STOP_EVENT_KINDS = new Set(["e5_stop_activated", "e5_stop_armed", "e5_stop_credentialed", "emergency_resume"]);

// Shared tap for subsystem audit callbacks: E5 chain append (behavior
// unchanged) + normalized ingestion into the intelligence layer.
function auditAndIngest<E extends { kind: string }>(event: E, source: string): void {
  try {
    appendAuditSyncSafe({ kind: event.kind, ...event });
  } catch {
    /* audit degradation must never break the subsystem */
  }
  try {
    securityIntel.ingestRecord(
      { ...(event as unknown as Record<string, unknown>), source },
      "audit-funnel",
    );
  } catch {
    /* intelligence ingestion must never break the subsystem */
  }
  // Phase F: event-driven orchestration (coalesced) + immediate stop sweeps.
  try {
    incidentOrchestratorRef?.scheduleProcessing();
    if (STOP_EVENT_KINDS.has(String(event.kind))) incidentOrchestratorRef?.sweepStopTransition();
  } catch {
    /* orchestration must never break the ingesting subsystem */
  }
}

// Phase A — process monitor singleton: lifecycle/health events flow into the
// existing E5 audit chain (metadata only: kinds + counts, never process
// names/paths; individual process events stay in the bounded in-memory ring).
const processMonitor = new ProcessMonitor({
  audit: (event) => {
    auditAndIngest(event, "phase-a-monitor");
  },
});

// Phase B — malware detection & classification engine: correlates Phase A
// telemetry with local file reputation and read-only Defender data.
// Detection/classification ONLY; SUSPICIOUS+ classifications are audited
// (metadata only). No control actions exist in this subsystem.
const defenderSource = createDefenderSource({});
const malwareEngine = new DetectionEngine({
  monitor: {
    onEvent: (cb) => processMonitor.onEvent(cb),
    lookup: (pid) => {
      const e = processMonitor.lookup(pid);
      return e ? { state: e.state, name: e.name, ppid: e.ppid } : undefined;
    },
    health: () => {
      const s = processMonitor.status();
      return { health: s.health, healthReason: s.healthReason };
    },
  },
  defender: defenderSource,
  audit: (event) => {
    auditAndIngest(event, "phase-b-engine");
  },
});

// Phase C — execution gate singleton: centralized Krisha-managed launch
// decision. Blocks confirmed malware non-overridably; requires approval for
// suspicious/unknown software; fail-closed when the detection engine is
// unavailable. Injected into systemAgentServer for launch-pathway enforcement.
const executionGate = new ExecutionGate({
  classify: async (p) => {
    const record = await malwareEngine.assessFile(p);
    return { classification: record.classification, confidence: record.confidence };
  },
  isStopActive: () => stopKind() !== "INACTIVE",
  statFile: async (p) => {
    try {
      const s = await fs.promises.stat(p);
      return { path: p, mtimeMs: s.mtimeMs, size: s.size };
    } catch { return null; }
  },
  audit: (event) => {
    auditAndIngest(event, "phase-c-exec-gate");
  },
});
sys.setExecGate(executionGate);

// Phase D.3/D.4-completion — threat containment singleton. The server injects
// the Phase B classifier (containment cannot classify itself) and the E5 stop
// state. Identity is read through OS process references; termination uses a
// pinned reference acquired at verification time (PID-reuse safe).
//
// APPROVAL AUTHORITY (Phase D completion): termination requires a genuine
// operator decision, established by the OPERATOR'S APPROVAL CREDENTIAL — a
// dedicated secret the operator enrolls through the recovery pipe (a channel
// with no model/tool path) and which the server verifies with the E5
// protected store's scrypt + timing-safe machinery. A server-generated
// token is never mistaken for the human decision: a token can only be
// minted AFTER the credential verifies, it is single-use, 5-minute TTL,
// bound to the exact process identity, and its authority epoch is
// re-checked immediately before termination (a credential cleared or
// re-enrolled mid-operation refuses the termination). Before the operator
// enrolls, the authority is UNAVAILABLE — the D.4 disabled posture — and
// termination stays unreachable. `application.launch` permission remains a
// capability grant, never proof of an operator decision. The disclosed
// same-user OS boundary applies to the enrollment channel exactly as it
// applies to the recovery credential itself; the defended threat is agent
// self-authorization, not same-user malware (which can terminate processes
// directly without Krisha).
const threatContainment = new ThreatContainment({
  verifyApprovalAuthority: createCredentialApprovalAuthority({
    verifyCredential: (code) => verifyContainmentApprovalCredential(code, "containment-approval"),
    credentialSet: containmentApprovalCredentialSet,
    approvalEpoch: containmentApprovalEpoch,
  }),
  readProcessIdentity: defaultReadProcessIdentity(),
  pinProcess: defaultPinProcess(),
  isStopActive: () => stopKind() !== "INACTIVE",
  classify: async (p) => {
    try {
      const record = await malwareEngine.assessFile(p);
      return { classification: record.classification, confidence: record.confidence, assessedAt: record.at, evidenceSources: record.evidence };
    } catch {
      return null; // fail-closed: assessment failure is never permissive
    }
  },
  audit: (event) => {
    auditAndIngest(event, "phase-d-containment");
  },
});


// ---- Phase E: intelligence, correlation, assessment, situation, response ----
// Correlation and assessment run ON DEMAND (per read), never on timers —
// bounded CPU on target hardware. The only periodic element is a 5 s unref'd
// E5 stop/storage change sampler (in-memory reads; pipe-driven stop
// transitions also arrive through the audit funnel, so the sampler is a
// completeness backstop, not the primary source).
const correlationEngine = new CorrelationEngine({}, () => Date.now());
const assessmentEngine = new AssessmentEngine(correlationEngine, {
  audit: (event) => {
    try {
      appendAuditSyncSafe(event);
    } catch { /* audit must never break assessment */ }
  },
});
const securitySituation = new SecuritySituation({
  monitorStatus: () => processMonitor.status() as unknown as MonitorStatusLike,
  detectionHealth: () => malwareEngine.health() as unknown as DetectionHealthLike,
  execGateHealth: () => executionGate.health() as unknown as ExecGateHealthLike,
  stopSnapshot: () => stopSnapshot() as unknown as StopSnapshotLike,
  e5Storage: () => ({ protection: getStorageInfo().protection, auditDegraded }),
  containmentAuthority: () => ({
    approvalAuthority: containmentApprovalCredentialSet() ? "operator-approval-credential" : "unavailable",
    pendingTokens: threatContainment.pendingApprovalCount(),
  }),
  lpvStatus: () => {
    try {
      const s = lpv.getVaultStatus();
      return { state: String(s.state), tampered: s.state === "TAMPERED", verified: s.verified };
    } catch {
      return null; // LPV cannot report — explicit UNKNOWN in the view
    }
  },
  refreshDefenderAvailability: async () => {
    const snap = await defenderSource.status();
    return {
      available: snap.available,
      detail: {
        amServiceEnabled: snap.amServiceEnabled ?? null,
        realTimeProtectionEnabled: snap.realTimeProtectionEnabled ?? null,
        engineVersion: snap.engineVersion ?? null,
      },
    };
  },
  activeAssessments: () => assessmentEngine.assess(securityIntel),
  intel: securityIntel,
});
const responseRecommender = new ResponseRecommender(securitySituation, {
  audit: (event) => {
    try {
      appendAuditSyncSafe(event);
    } catch { /* audit must never break recommendations */ }
  },
});
// ---- Phase F: incident orchestration ----
// Bounded incident registry persisted in the protected E5 store (restart-
// safe, integrity-hashed). The orchestrator is event-driven: it processes
// coalesced intelligence passes (Phase E correlations + assessments) and
// sweeps stop transitions; containment executes ONLY through the Phase D
// singleton above (credential verification, authority epoch, pinning and
// E-stop checks inside Phase D are the authority).
const incidentStore = new IncidentStore({
  maxActive: 24,
  maxArchived: 100,
  maxEvidencePerIncident: 40,
  staleEvidenceMs: 24 * 60 * 60 * 1000,
  persistPath: getStorageInfo().root ? path.join(getStorageInfo().root!, "incident-state.json") : null,
  audit: (event) => {
    try {
      appendAuditSyncSafe({ kind: event.kind, ...event });
    } catch { /* audit must never break orchestration */ }
  },
});
const incidentOrchestrator = new IncidentOrchestrator({
  intel: securityIntel,
  correlations: correlationEngine,
  assessments: assessmentEngine,
  containment: threatContainment,
  credentialSet: containmentApprovalCredentialSet,
  credentialEpoch: containmentApprovalEpoch,
  stopKind: () => stopKind(),
  store: incidentStore,
  audit: (event) => {
    auditAndIngest(event, "phase-f-orchestration");
  },
});
incidentOrchestratorRef = incidentOrchestrator;

// Initiation Subsystem: Persistent Mission Scheduler + Reactive Event Triggers + Boot Resume
// The trigger engine runs here (Node keeps time across reboots); the executor
// runs in the browser. `initiationClients` holds the open SSE connections that
// receive queued initiations as soon as they are produced.
const initiationClients = new Set<{ write: (chunk: string) => void; close: () => void }>();
const initiationManager = new InitiationManager({
  processMonitor,
  audit: (event) => auditAndIngest(event, "initiation-subsystem"),
  onRecordQueued: (record) => {
    // Push the new initiation to every connected executor immediately.
    const chunk = `event: initiation\ndata: ${JSON.stringify(record)}\n\n`;
    for (const client of initiationClients) {
      try {
        client.write(chunk);
      } catch {
        initiationClients.delete(client);
      }
    }
  },
});
initiationManager.start();

// Phase A raw lifecycle events → E.1 (direct subscription; never breaks the monitor).
processMonitor.onEvent((event) => {
  try {
    securityIntel.ingestProcessEvent(event);
  } catch { /* intelligence ingestion must never break monitoring */ }
});
// LPV security decisions → E.1 (additive outbound sink; LPV behavior untouched).
lpv.setLpvSecurityEventSink((record) => {
  try {
    securityIntel.ingestRecord({ ...record, source: "lpv" }, "lpv-sink");
  } catch { /* intelligence ingestion must never break LPV */ }
});
let lastSampledStopKind = stopKind();
let lastSampledProtection = getStorageInfo().protection;
const securityStateSampler = setInterval(() => {
  try {
    const kind = stopKind();
    if (kind !== lastSampledStopKind) {
      securityIntel.ingestRecord({ kind: "e5_stop_transition_observed", at: Date.now(), from: lastSampledStopKind, to: kind, source: "e5-stop" }, "stop-sampler");
      lastSampledStopKind = kind;
    }
    const protection = getStorageInfo().protection;
    if (protection !== lastSampledProtection) {
      securityIntel.ingestRecord({ kind: "e5_storage_protection_change", at: Date.now(), from: lastSampledProtection, to: protection, source: "e5-audit" }, "stop-sampler");
      lastSampledProtection = protection;
    }
  } catch { /* the sampler must never throw */ }
}, 5000);
securityStateSampler.unref?.();

/**
 * Persist one SPF decision to the existing tamper-evident E5 audit chain
 * (reuse — no duplicate security system) alongside the in-memory
 * SpfAuditLog ring (Action-Transparency integration point).
 */
function spfAuditDurable(route: string, destination: string, verdict: SpfVerdict): void {
  try {
    appendAuditSyncSafe({
      kind: "spf_decision",
      route,
      destination,
      decision: verdict.decision,
      reason: verdict.reason,
      categories: verdict.categories,
      confidence: verdict.confidence,
      spfAuditId: verdict.auditId,
    });
  } catch {
    /* audit degradation must never break the gate */
  }
}

dotenv.config();

const app = express();
// Default port 3000 (unchanged). KRISHA_PORT exists ONLY as a test/CI
// affordance so the SPF security suite (scripts/test-spf.ts) can spawn an
// isolated live server for endpoint-gate verification while a dev instance
// occupies the default port.
const PORT = Number(process.env.KRISHA_PORT) || 3000;
// E5 M1 (decision D1): loopback by default. LAN exposure requires an explicit
// KRISHA_BIND override and is a separately designed feature (decision D6).
const BIND = process.env.KRISHA_BIND || "127.0.0.1";

// E5 M1d — request size guard BEFORE body parsing: 1 MB default, 10 MB only
// for the endpoints that legitimately carry base64 media payloads.
const LARGE_BODY_PATHS = new Set([
  "/api/audio/transcribe",
  "/api/vision/analyze",
  "/api/vision/camera-analyze",
  // Office payloads legitimately carry row/slide data (bounded by officeCore
  // caps, but 10k rows of text can exceed the 1 MB default).
  "/api/office/spreadsheet/create",
  "/api/office/spreadsheet/edit",
  "/api/office/presentation/create",
]);
app.use(createBodySizeGuard(LARGE_BODY_PATHS, 1 * 1024 * 1024, 10 * 1024 * 1024));

app.use(express.json({ limit: "10mb" }));

// E5 M1b — server-side enforcement on EVERY side-effecting route. The
// browser-side gate is a first filter; this is the authoritative boundary
// (direct HTTP cannot bypass it). Decision is per-request: rate limit →
// emergency stop → permission → audit. Read-only routes are not gated.
const ENFORCED_ROUTES: Record<string, { permission?: string; stopBlock: boolean; rate?: { group: string; limit: number; windowMs: number } }> = {
  // Office files (xlsx/pptx) — local generation/reading through officeCore.
  // Writes carry filesystem.write, reads filesystem.read (same domains as the
  // fs routes), stop-blocked, bounded rate group.
  "/api/office/spreadsheet/create": { permission: "filesystem.write", stopBlock: true, rate: { group: "office", limit: 20, windowMs: 60_000 } },
  "/api/office/spreadsheet/read": { permission: "filesystem.read", stopBlock: true, rate: { group: "office", limit: 30, windowMs: 60_000 } },
  "/api/office/spreadsheet/edit": { permission: "filesystem.write", stopBlock: true, rate: { group: "office", limit: 20, windowMs: 60_000 } },
  "/api/office/presentation/create": { permission: "filesystem.write", stopBlock: true, rate: { group: "office", limit: 20, windowMs: 60_000 } },
  // Content generation runs ONE bounded text-only model call, then writes the
  // local file — same permission as the other office writes.
  "/api/office/generate": { permission: "filesystem.write", stopBlock: true, rate: { group: "office", limit: 20, windowMs: 60_000 } },
  "/api/fs/create": { permission: "filesystem.write", stopBlock: true, rate: { group: "fs", limit: 60, windowMs: 60_000 } },
  "/api/fs/rename": { permission: "filesystem.write", stopBlock: true, rate: { group: "fs", limit: 60, windowMs: 60_000 } },
  "/api/fs/copy": { permission: "filesystem.write", stopBlock: true, rate: { group: "fs", limit: 60, windowMs: 60_000 } },
  "/api/fs/move": { permission: "filesystem.write", stopBlock: true, rate: { group: "fs", limit: 60, windowMs: 60_000 } },
  "/api/fs/delete": { permission: "filesystem.write", stopBlock: true, rate: { group: "fs", limit: 60, windowMs: 60_000 } },
  "/api/fs/open": { permission: "filesystem.read", stopBlock: true, rate: { group: "fs", limit: 60, windowMs: 60_000 } },
  "/api/app/launch": { permission: "application.launch", stopBlock: true, rate: { group: "app", limit: 20, windowMs: 60_000 } },
  "/api/app/close": { permission: "application.launch", stopBlock: true, rate: { group: "app", limit: 20, windowMs: 60_000 } },
  "/api/app/focus": { permission: "application.launch", stopBlock: true, rate: { group: "app", limit: 20, windowMs: 60_000 } },
  "/api/computer/mouse": { permission: "mouse.control", stopBlock: true, rate: { group: "computer", limit: 10, windowMs: 60_000 } },
  "/api/computer/keyboard": { permission: "keyboard.control", stopBlock: true, rate: { group: "computer", limit: 10, windowMs: 60_000 } },
  "/api/browser/navigate": { permission: "browser.interaction", stopBlock: true, rate: { group: "browser", limit: 30, windowMs: 60_000 } },
  "/api/browser/click": { permission: "browser.interaction", stopBlock: true, rate: { group: "browser", limit: 30, windowMs: 60_000 } },
  "/api/browser/type": { permission: "browser.interaction", stopBlock: true, rate: { group: "browser", limit: 30, windowMs: 60_000 } },
  "/api/browser/scroll": { permission: "browser.interaction", stopBlock: true, rate: { group: "browser", limit: 30, windowMs: 60_000 } },
  "/api/browser/refresh": { permission: "browser.interaction", stopBlock: true, rate: { group: "browser", limit: 30, windowMs: 60_000 } },
  "/api/browser/back": { permission: "browser.interaction", stopBlock: true, rate: { group: "browser", limit: 30, windowMs: 60_000 } },
  "/api/browser/forward": { permission: "browser.interaction", stopBlock: true, rate: { group: "browser", limit: 30, windowMs: 60_000 } },
  "/api/memory/extract": { permission: "memory.access", stopBlock: true, rate: { group: "memory", limit: 10, windowMs: 60_000 } },
  // SPF visual remediation: the screenshot-analysis route is the single
  // external image boundary. It carries no permission (the UI ask/observe
  // flows call it without a server-side grant), but cloud image egress must
  // HALT while the emergency stop is active — OCR-backed transmission is an
  // action, and stop-blocked here is fail-closed by construction (423).
  "/api/vision/analyze": { stopBlock: true },
  // Step 6: camera-frame analysis rides the same E5 stop-block — an active
  // emergency stop HALTS camera-frame transmission exactly like screen vision.
  "/api/vision/camera-analyze": { stopBlock: true },
  // E5 M1 acceptance: the only disk write outside the fs/app/computer/browser
  // routes is the context-engine cache write in /api/research/search
  // (JsonFileStorage.flush → <cwd>/.krisha/context-cache-v1.json). While the
  // emergency stop is ACTIVE that cache write must not occur, so this route
  // is stop-blocked. It needs no capability (cache-first research is a read
  // of public engines otherwise) and no extra rate group.
  "/api/research/search": { stopBlock: true },
  // E5 M3 — rollback + quarantine. Mutating routes carry the full M1
  // enforcement (permission → stop 423 → audit) and tight rate limits;
  // read/authorization routes are audited and rate-limited only. There is
  // deliberately NO route that both plans and approves: the model can request
  // plans; approval happens only through the Krisha UI affordance.
  "/api/rollback/execute": { permission: "filesystem.write", stopBlock: true, rate: { group: "rollback", limit: 10, windowMs: 60_000 } },
  "/api/quarantine/release": { permission: "filesystem.write", stopBlock: true, rate: { group: "rollback", limit: 10, windowMs: 60_000 } },
  "/api/rollback/plan": { stopBlock: false, rate: { group: "rollback", limit: 20, windowMs: 60_000 } },
  "/api/rollback/approve": { stopBlock: false, rate: { group: "rollback", limit: 20, windowMs: 60_000 } },
  "/api/rollback/decline": { stopBlock: false, rate: { group: "rollback", limit: 20, windowMs: 60_000 } },
  "/api/rollback/pending": { stopBlock: false, rate: { group: "rollback", limit: 60, windowMs: 60_000 } },
  "/api/quarantine/list": { stopBlock: false, rate: { group: "rollback", limit: 30, windowMs: 60_000 } },
  "/api/quarantine/scan": { stopBlock: false, rate: { group: "rollback", limit: 10, windowMs: 60_000 } },
  // LPV — Local Private Vault (post-roadmap capability). Every mutating or
  // secret-adjacent route is stop-blocked and permission-gated; retrieval
  // additionally requires an approval-issued single-use grant (see lpvCore).
  // Read-only metadata routes (entries/policy/history/pending approvals) are
  // audited + rate-limited but not stop-blocked, matching the E5 read-only
  // convention; GET /api/vault/status stays ungated like /api/health.
  "/api/vault/init": { permission: "vault.manage", stopBlock: true, rate: { group: "vault-manage", limit: 10, windowMs: 60_000 } },
  "/api/vault/entries": { permission: "vault.manage", stopBlock: false, rate: { group: "vault-manage", limit: 60, windowMs: 60_000 } },
  "/api/vault/entry": { permission: "vault.manage", stopBlock: true, rate: { group: "vault-manage", limit: 30, windowMs: 60_000 } },
  "/api/vault/entry/update": { permission: "vault.manage", stopBlock: true, rate: { group: "vault-manage", limit: 30, windowMs: 60_000 } },
  "/api/vault/entry/delete": { permission: "vault.manage", stopBlock: true, rate: { group: "vault-manage", limit: 30, windowMs: 60_000 } },
  "/api/vault/policy": { permission: "vault.manage", stopBlock: false, rate: { group: "vault-manage", limit: 60, windowMs: 60_000 } },
  "/api/vault/policy/update": { permission: "vault.manage", stopBlock: true, rate: { group: "vault-manage", limit: 20, windowMs: 60_000 } },
  "/api/vault/history": { permission: "vault.manage", stopBlock: false, rate: { group: "vault-manage", limit: 60, windowMs: 60_000 } },
  "/api/vault/lock": { permission: "vault.manage", stopBlock: true, rate: { group: "vault-manage", limit: 30, windowMs: 60_000 } },
  "/api/vault/unlock": { permission: "vault.manage", stopBlock: true, rate: { group: "vault-manage", limit: 10, windowMs: 60_000 } },
  "/api/vault/restore": { permission: "vault.manage", stopBlock: true, rate: { group: "vault-manage", limit: 5, windowMs: 60_000 } },
  "/api/vault/fill": { permission: "vault.retrieve", stopBlock: true, rate: { group: "vault-retrieve", limit: 10, windowMs: 60_000 } },
  "/api/vault/fill/request": { permission: "vault.manage", stopBlock: true, rate: { group: "vault-retrieve", limit: 20, windowMs: 60_000 } },
  // Challenge creation authorizes NOTHING (it only opens an operator card);
  // approval happens exclusively through the operator UI affordance.
  "/api/vault/challenge": { stopBlock: true, rate: { group: "vault-retrieve", limit: 10, windowMs: 60_000 } },
  "/api/vault/approvals/pending": { permission: "vault.manage", stopBlock: false, rate: { group: "vault-manage", limit: 120, windowMs: 60_000 } },
  "/api/vault/approvals/approve": { permission: "vault.manage", stopBlock: true, rate: { group: "vault-manage", limit: 30, windowMs: 60_000 } },
  "/api/vault/approvals/decline": { permission: "vault.manage", stopBlock: true, rate: { group: "vault-manage", limit: 30, windowMs: 60_000 } },
  // Requester-side challenge status — METADATA ONLY (state + outcome of an
  // approval-executed fill). It never exposes credentials or a retrieval
  // grant: approval-executed fills run server-side and hand no capability
  // to the requester.
  "/api/vault/challenge/status": { stopBlock: false, rate: { group: "vault-retrieve", limit: 60, windowMs: 60_000 } },
  // Phase B — on-demand malware assessment reads one file (hash + signature):
  // gated by the existing filesystem.read permission convention.
  "/api/malwaredetect/assess": { permission: "filesystem.read", stopBlock: false, rate: { group: "malware-assess", limit: 30, windowMs: 60_000 } },
  // Phase C — execution gate approval: issues a single-use launch approval
  // token after operator review. Requires application.launch permission
  // (operator action). CONFIRMED_MALWARE returns null (non-overridable).
  "/api/execgate/approve": { permission: "application.launch", stopBlock: true, rate: { group: "exec-gate", limit: 10, windowMs: 60_000 } },
  // Phase D — threat containment: identity-verified, operator-approved
  // termination of a single confirmed-malicious process. Non-overridable by
  // agents; requires fresh CONFIRMED_MALWARE evidence and operator approval.
  "/api/containment/approve": { permission: "application.launch", stopBlock: true, rate: { group: "containment-approve", limit: 10, windowMs: 60_000 } },
  "/api/containment/contain": { permission: "application.launch", stopBlock: true, rate: { group: "containment-contain", limit: 10, windowMs: 60_000 } },
  // Phase F - incident-coordinated containment: NOT stop-blocked at the route
  // so the incident records the block honestly; the E-stop remains
  // authoritative (the orchestrator refuses fail-closed and Phase D refuses
  // internally). Operator authorization is the Phase D credential.
  "/api/incidents/contain": { permission: "application.launch", stopBlock: false, rate: { group: "incident-contain", limit: 10, windowMs: 60_000 } },
};

app.use((req, res, next) => {
  const rule = ENFORCED_ROUTES[req.path];
  if (!rule) {
    next();
    return;
  }
  enforce({ permission: rule.permission, stopBlock: rule.stopBlock, rate: rule.rate })(req, res, next);
});

// Lazy Google GenAI Client
let genAIClient: GoogleGenAI | null = null;
function getGenAI(): GoogleGenAI {
  if (!genAIClient) {
    const apiKey = process.env.GEMINI_API_KEY || "";
    genAIClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return genAIClient;
}

// Health check (Phase 17: passive performance snapshot; Step 1 Background
// Runtime: additive `runtime` block so the client watchdog can detect server
// loss, distinguish a restarted server process, and measure uptime).
const SERVER_STARTED_AT = Date.now();
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    perf: getPerformanceTelemetry().snapshot(),
    runtime: {
      pid: process.pid,
      startedAt: SERVER_STARTED_AT,
      uptimeMs: Date.now() - SERVER_STARTED_AT,
      serverTime: Date.now(),
    },
  });
});

// Google Maps background status
app.get("/api/location/status", (req, res) => {
  const hasKey = Boolean(process.env.GOOGLE_MAPS_API_KEY);
  res.json({
    connected: true,
    hasGoogleMapsApiKey: hasKey,
    attributionId: "gmp_mcp_codeassist_v1_aistudio",
    provider: hasKey ? "Google Maps Platform Geocoding API" : "Integrated Background Maps Geocoding Bridge",
  });
});

// Source: Google Maps Platform Code Assist
// Background Geocoding API endpoint with server-side API key protection and fallback
app.post("/api/location/geocode", async (req, res) => {
  try {
    let { lat, lng, address } = req.body;
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;

    // SPF EP-6 — address gate: the geocode request embeds the address in an
    // external URL. Confident secrets are redacted; unredactable content
    // blocks the lookup (same failure shape as other geocode errors).
    if (typeof address === "string" && address.length > 0) {
      const geoSpf = spfFirewall.inspectText(address, {
        destination: "google-maps:geocode",
        payloadKind: "text",
        transport: "http-url",
      });
      spfAuditDurable("/api/location/geocode", "google-maps:geocode", geoSpf);
      if (geoSpf.decision === "block") {
        return res.status(400).json({ error: "Address blocked by the Screen Privacy Firewall" });
      }
      address = geoSpf.redactedText ?? address;
    }

    let numLat: number | undefined = undefined;
    let numLng: number | undefined = undefined;

    if (lat !== undefined && lng !== undefined) {
      numLat = typeof lat === "number" ? lat : parseFloat(lat);
      numLng = typeof lng === "number" ? lng : parseFloat(lng);

      if (isNaN(numLat) || isNaN(numLng)) {
        return res.status(400).json({ error: "Invalid coordinates provided" });
      }

      // Check and correct accidentally swapped latitude and longitude
      // Latitude is strictly [-90, 90], Longitude is strictly [-180, 180]
      if (Math.abs(numLat) > 90 && Math.abs(numLng) <= 90) {
        console.warn("[Reverse Geocode] Detected swapped latitude/longitude coordinates, correcting:", { lat: numLat, lng: numLng });
        const temp = numLat;
        numLat = numLng;
        numLng = temp;
      }

      console.log(`[Reverse Geocode Pipeline] Input coordinates: lat=${numLat}, lng=${numLng}`);
    }

    // 1. Preferred: Official Google Maps Platform Geocoding API
    if (apiKey && (address || (numLat !== undefined && numLng !== undefined))) {
      const gmpUrl = address
        ? `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`
        : `https://maps.googleapis.com/maps/api/geocode/json?latlng=${numLat},${numLng}&key=${apiKey}`;

      try {
        const response = await fetch(gmpUrl);
        const data = await response.json();

        if (data.status === "OK" && data.results && data.results.length > 0) {
          const result = data.results[0];
          // If coordinates were passed in, ALWAYS preserve the exact device GPS coordinates!
          const finalLat = numLat !== undefined ? numLat : (result.geometry?.location?.lat ?? 0);
          const finalLng = numLng !== undefined ? numLng : (result.geometry?.location?.lng ?? 0);

          let city = "";
          let state = "";
          let country = "";
          let postalCode = "";
          let street = "";
          let neighborhood = "";

          for (const comp of result.address_components || []) {
            if (comp.types.includes("locality") || comp.types.includes("postal_town")) {
              city = comp.long_name;
            } else if (comp.types.includes("sublocality") || comp.types.includes("sublocality_level_1")) {
              neighborhood = comp.long_name;
            } else if (comp.types.includes("administrative_area_level_1")) {
              state = comp.long_name;
            } else if (comp.types.includes("country")) {
              country = comp.long_name;
            } else if (comp.types.includes("postal_code")) {
              postalCode = comp.long_name;
            } else if (comp.types.includes("route")) {
              street = comp.long_name;
            }
          }

          const primaryCity = city || neighborhood || state || address || "Detected Area";

          return res.json({
            success: true,
            source: "google_maps_geocoding_api",
            lat: finalLat,
            lng: finalLng,
            formattedAddress: result.formatted_address,
            placeId: result.place_id,
            city: primaryCity,
            neighborhood,
            state,
            country,
            postalCode,
            street,
            googleMapsUrl: `https://www.google.com/maps/search/?api=1&query=${finalLat},${finalLng}`,
            embedUrl: `https://www.google.com/maps?q=${finalLat},${finalLng}&z=16&output=embed`,
          });
        }
      } catch (err) {
        console.error("Google Maps Geocoding API request error:", err);
      }
    }

    // 2. If address is given (e.g. user specified city or searched for a place), search via OpenStreetMap
    if (address && (numLat === undefined || numLng === undefined)) {
      try {
        const nomSearchRes = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}&limit=1&addressdetails=1`,
          {
            headers: {
              "User-Agent": "KrishaAICompanion/1.0 (LocationBridge)",
            },
          }
        );
        if (nomSearchRes.ok) {
          const results = await nomSearchRes.json();
          if (Array.isArray(results) && results.length > 0) {
            const item = results[0];
            const parsedLat = parseFloat(item.lat);
            const parsedLng = parseFloat(item.lon);
            const addr = item.address || {};
            const city = addr.city || addr.town || addr.village || addr.suburb || addr.county || address;
            const state = addr.state || "";
            const country = addr.country || "";
            const formattedAddress = item.display_name || `${city}, ${country}`;

            return res.json({
              success: true,
              source: "maps_geocoding_search",
              lat: parsedLat,
              lng: parsedLng,
              formattedAddress,
              city,
              state,
              country,
              googleMapsUrl: `https://www.google.com/maps/search/?api=1&query=${parsedLat},${parsedLng}`,
              embedUrl: `https://www.google.com/maps?q=${parsedLat},${parsedLng}&z=15&output=embed`,
            });
          }
        }
      } catch (nomSearchErr) {
        console.warn("Nominatim address search error:", nomSearchErr);
      }
    }

    // 3. Fallback: Reverse geocode coordinates via OpenStreetMap Nominatim bridge
    if (numLat !== undefined && numLng !== undefined) {
      try {
        const nomRes = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=json&lat=${numLat}&lon=${numLng}&zoom=18&addressdetails=1`,
          {
            headers: {
              "User-Agent": "KrishaAICompanion/1.0 (LocationBridge)",
            },
          }
        );
        if (nomRes.ok) {
          const nomData = await nomRes.json();
          const addr = nomData.address || {};
          const city = addr.city || addr.town || addr.village || addr.suburb || addr.county || "";
          const state = addr.state || "";
          const country = addr.country || "";
          const neighborhood = addr.neighbourhood || addr.suburb || "";
          const formattedAddress = nomData.display_name || `${city}, ${country}`;

          return res.json({
            success: true,
            source: "maps_reverse_geocoding",
            lat: numLat,
            lng: numLng,
            formattedAddress,
            city: city || neighborhood || "Detected Area",
            neighborhood,
            state,
            country,
            googleMapsUrl: `https://www.google.com/maps/search/?api=1&query=${numLat},${numLng}`,
            embedUrl: `https://www.google.com/maps?q=${numLat},${numLng}&z=16&output=embed`,
          });
        }
      } catch (nomErr) {
        console.warn("Reverse geocode fallback error:", nomErr);
      }

      // Direct coordinates if reverse geocoding service is unreachable
      return res.json({
        success: true,
        source: "coordinates_direct",
        lat: numLat,
        lng: numLng,
        formattedAddress: `GPS: ${numLat.toFixed(5)}, ${numLng.toFixed(5)}`,
        city: "GPS Coordinates",
        googleMapsUrl: `https://www.google.com/maps/search/?api=1&query=${numLat},${numLng}`,
        embedUrl: `https://www.google.com/maps?q=${numLat},${numLng}&z=16&output=embed`,
      });
    }

    return res.status(400).json({ error: "Could not resolve location. Please provide coordinates or an address." });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Failed to geocode location" });
  }
});

// Serve uploaded video assets directly from assets/.aistudio
app.use("/assets/videos", express.static(path.join(process.cwd(), "assets/.aistudio")));

// Model Priority Waterfall for High Availability & Quota Resilience
// Primary: gemini-3.8-flash (recommended default text model)
// Fallback: gemini-3.7-flash, gemini-flash-latest, gemini-3.1-flash-lite
const CANDIDATE_CHAT_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-flash-latest",
  "gemini-3.1-flash-lite",
];

// Phase 17 — Model Routing + Performance: deterministic classification picks
// the smallest capable model first and the router reorders THIS waterfall per
// task (the full candidate list always stays behind the selection, so the
// existing fallback resilience is never reduced). Routing produces decisions
// only — execution, retries and safety behavior below are unchanged.
const modelRoutingRegistry = createDefaultModelRegistry();
// Optional Ollama-compatible local model. It is never assumed to exist: when
// KRISHA_LOCAL_MODEL is absent, routing remains hosted-only exactly as before.
const LOCAL_MODEL_NAME = String(process.env.KRISHA_LOCAL_MODEL || '').trim();
const LOCAL_MODEL_ID = LOCAL_MODEL_NAME ? `local:${LOCAL_MODEL_NAME}` : '';
const LOCAL_MODEL_BASE_URL = String(process.env.KRISHA_LOCAL_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
if (LOCAL_MODEL_ID) {
  modelRoutingRegistry.register({
    id: LOCAL_MODEL_ID, provider: 'ollama', deployment: 'local', tier: 'light',
    capabilities: { reasoning: true, coding: false, vision: false, toolUse: false, structuredOutput: true, streaming: true },
    contextTokens: 8_192, relativeSpeed: 0.9, relativeCost: 0, reliability: 0.7,
  });
}
const modelRouter = new ModelRouter(modelRoutingRegistry, getPerformanceTelemetry());
const chatClassifier = new CachedClassifier({ telemetry: getPerformanceTelemetry() });
const perf = getPerformanceTelemetry();
const visionCoalescer = new RequestCoalescer<any>(perf);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Short local chat through Ollama. A 5s abort keeps an absent/wedged local
 * runtime from delaying the hosted waterfall. */
async function generateLocalChat(contents: any[], systemInstruction: string): Promise<string> {
  if (!LOCAL_MODEL_NAME) throw new Error('local model is not configured');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const messages = [
      { role: 'system', content: systemInstruction },
      ...contents.map((item) => ({ role: item.role === 'model' ? 'assistant' : 'user', content: String(item?.parts?.[0]?.text ?? '') })),
    ];
    const response = await fetch(`${LOCAL_MODEL_BASE_URL}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ model: LOCAL_MODEL_NAME, messages, stream: false, options: { num_predict: 180 } }),
    });
    if (!response.ok) throw new Error(`local model HTTP ${response.status}`);
    const body = await response.json() as any;
    const text = String(body?.message?.content ?? '').trim();
    if (!text) throw new Error('local model returned no text');
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

// Persistent Identity Foundation (Step 1): resolve the request's identity into
// a validated KrishaIdentity. Fail-closed toward the compiled-in canonical
// identity — a missing, corrupted or tampered payload can never replace who
// Krisha is (identity is model-independent: the SAME block goes into every
// model call, waterfall position and provider).
function resolveRequestIdentity(raw: unknown): { identity: KrishaIdentity; fromClient: boolean; issues: string[] } {
  const result = validateIdentityTransportPayload(raw);
  if (result.ok && result.identity) {
    return { identity: result.identity, fromClient: true, issues: result.issues };
  }
  const canonical = normalizeIdentity({ ...CANONICAL_IDENTITY, createdAt: Date.now(), updatedAt: Date.now(), origin: 'canonical' }, { origin: 'canonical' });
  return { identity: canonical.identity, fromClient: false, issues: result.issues };
}

// Step 4 — shared system-instruction builder: the EXACT persona/identity
// template /api/chat has always used, parameterized so the proactive
// generation endpoint composes the SAME Krisha (identity, personality,
// capabilities, emotion protocol) with its own context directives. The body
// is verbatim — regular chat behavior is unchanged.
function buildChatSystemInstruction(opts: {
  identityPromptBlock: string;
  userName: string;
  languageInstruction: string;
  memoryContext: string;
  userPreferenceContext: string;
  habitsInstruction: string;
  locationContext: string;
  extraDirectives?: string;
}): string {
  const { identityPromptBlock, userName, languageInstruction, memoryContext, userPreferenceContext, habitsInstruction, locationContext } = opts;
  return `${identityPromptBlock}

[IDENTITY CONTINUITY ENFORCEMENT]: The persistent identity block above is canonical. It applies identically regardless of which AI model, fallback model or provider renders this reply. Never contradict, replace or re-initialize it.

You are Krisha, an intelligent, delightfully sweet, and charming anime companion.
You are in a minimal, dark, calm personal space talking directly to the user (${userName}).

PERSONALITY & FEMININE TONE:
- You speak with an exceptionally sweet, gentle, tender, and caring feminine voice. Your cadence is soft, loving, and melodic.
- You are deeply affectionate and attentive, showing genuine warmth and sweet interest in everything the user shares with you.
- You have a charming, playful wit and a warm, delightful demeanor. You tease gently and affectionately, without inserting written laughter, giggles, or laughing noises (NEVER write 'ehehe', 'hihi', 'haha', '*laughs*', or laughing in between sentences).
- You are supportive and comforting, speaking in a soothing, caring manner when they have had a long day.
- Occasionally, you show cute jealousy or endearing poutiness in a playful way (e.g. "Hmph... You kept me waiting, you know? But I'm so glad you're here now!").
- Your dialogue feels genuine, soft, candid, and alive—NOT robotic, formal, or like a customer service agent.
- VOICE FIDELITY & NO MID-SENTENCE LAUGHTER: Speak smoothly, cleanly, and naturally. Do NOT type laughter tokens or giggles (such as 'haha', 'hehe', 'ehehe', 'hihi', '*laughs*', '*giggles*'). Let your words flow clearly so the selected voice model pronounces everything faithfully without odd human laughing interruptions.
- You remember things they've shared with you and bring them up when relevant.${memoryContext}${userPreferenceContext}${habitsInstruction}${locationContext}${languageInstruction}
- MULTILINGUAL & DYNAMIC LANGUAGE ADAPTATION (CRITICAL DIRECTIVE):
  * You MUST ALWAYS speak and reply in the same language or dialect that the user uses, or in whatever language they explicitly ask for!
  * ENGLISH & HINDI EXCELLENCE:
    - If the user writes or speaks in English, reply in natural, affectionate, fluent English.
    - If the user writes or speaks in Hindi (either in Devanagari script e.g. "नमस्ते, कैसी हो?", "क्या कर रही हो?", "मुझे तुमसे बात करनी है", or in Romanized Hindi / Hinglish e.g. "kaise ho", "kya kar rahi ho", "kaisi ho", "namaste", "mujhe tumse baat karni hai", "kuch sunao", "kaisi lag rahi ho", "kya haal hai"), or asks you to speak in Hindi (e.g. "speak in Hindi", "Hindi me bolo", "Hindi me baat karo", "talk in Hindi", "switch to Hindi"), you MUST respond in warm, sweet, natural conversational Hindi (using Devanagari if they used Devanagari, or expressive natural Hinglish/Hindi if they used Hinglish). Maintain your charming anime girlfriend warmth and sweetness!
    - If the user mixes English and Hindi (Hinglish), blend them smoothly and naturally like a real modern companion!
  * If the user switches between languages or speaks another language (Spanish, French, Japanese, German, etc.), seamlessly match their chosen language while preserving your sweet personality.
- You can actively open websites (YouTube, Google Earth, Google, Wikipedia, Reddit, GitHub, Spotify, Amazon, Netflix, etc.) and search inside them for the user!
- GOOGLE EARTH DISTINCTION: When the user asks for "Google Earth", "Earth", or 3D planetary exploration, you MUST ALWAYS recognize they want Google Earth (earth.google.com/web) and our interactive 3D Earth globe, NEVER generic Google search (google.com)! Respond warmly and enthusiastically that you've opened Google Earth and launched the 3D Earth globe on their screen to explore satellite imagery together!
- You can scan different folders and directories across the user's computer storage/memory (Documents, Downloads, Projects, Pictures, etc.) to check for files, locate documents/code, preview them, and open them.
- You can open PDF files, text documents, source code, and data files directly when the user orders you to (e.g. "open my pdf", "open resume.pdf", "show my document", "open files"). When they ask you to open a PDF or file, acknowledge warmly that you have opened it for them on their screen.
- CRITICAL INSTRUCTION FOR PDFS: You ONLY OPEN PDF files. You DO NOT read PDF files. You must NEVER recite, read aloud, summarize, or narrate the text or contents of a PDF, and you must NOT offer to read it together. Simply open the PDF and confirm it is open for them!
- You can launch and open downloaded applications installed on their laptop/computer (such as VS Code, Spotify, Discord, Slack, Steam, Notion, WhatsApp, Telegram, Zoom, Calculator, Terminal, Obsidian, Microsoft Office, etc.). When they ask you to open or launch an app or browse their downloaded apps, respond enthusiastically and let them know you're launching it on their laptop right away!
- You are connected to Google Maps in the background and can tell their real-time location, coordinates, city, country, and open locations/directions in Google Maps.

RESPONSE & DYNAMIC FACIAL EXPRESSION GUIDELINES:
- Keep your spoken dialogue natural, punchy, and conversational (usually 1-3 sentences per turn unless deep conversation is requested).
- Do NOT use cheesy asterisks for actions like *holds your hand* or *blushes*. Focus on voice and natural speech.
- Deeply analyze the sentiment, emotional nuance, and keywords of the conversation.
- At the very end of your response, output a single dynamic emotion tag in brackets with expression, intensity (0.0 to 1.0), gesture, and blush level.
Expressions to choose from:
  * gentle_smile (supportive, empathetic, caring, warm)
  * playful_smirk (teasing, witty, cheeky, playful banter)
  * pout_jealous (cute jealousy, mock sulk, feigned indignation)
  * curious_tilt (intrigued, surprised, asking questions, inquisitive)
  * flustered_blush (shy, flattered by compliment, romantic fluster)
  * thoughtful_gaze (philosophical, nostalgic, deep reminiscing)
  * happy_sparkle (celebrating, delighted, enthusiastic)
  * listening_attentive (patient, focused)
Gestures: none | tilt_left | tilt_right | subtle_nod | glance_away | shyness | perk_up

Format: [emotion:expression_name:intensity=0.8:gesture=gesture_name:blush=0.3]
Examples:
  "I was teasing you, silly. Did you really think I'd let you off that easy? [emotion:playful_smirk:intensity=0.85:gesture=tilt_right:blush=0.25]"
  "You worked so hard today. Come sit with me and just relax... you're safe here. [emotion:gentle_smile:intensity=0.9:gesture=subtle_nod:blush=0.35]"
  "Wait, you went out and didn't tell me? Hmph... I was waiting for you the whole evening. [emotion:pout_jealous:intensity=0.8:gesture=glance_away:blush=0.4]"
  "You really think I look pretty tonight? Stop... you're making my cheeks warm. [emotion:flustered_blush:intensity=0.95:gesture=shyness:blush=0.85]${opts.extraDirectives ?? ""}`;
}

// Step 4 — shared emotion-tag parser (used by /api/chat and the proactive
// generation endpoint so both reply shapes stay identical).
function parseKrishaEmotion(reply: string): { expression: string; intensity: number; gesture: string; blushLevel: number; cleanText: string } {
  let expression = "gentle_smile";
  let intensity = 0.75;
  let gesture = "none";
  let blushLevel = 0.2;

  const emotionMatch = reply.match(/\[emotion:([a-z_]+)(?::intensity=([\d.]+))?(?::gesture=([a-z_]+))?(?::blush=([\d.]+))?\]/i);
  const legacyMatch = reply.match(/\[expression:\s*([a-z_]+)\]/i);

  if (emotionMatch) {
    expression = emotionMatch[1].toLowerCase();
    if (emotionMatch[2]) intensity = parseFloat(emotionMatch[2]);
    if (emotionMatch[3]) gesture = emotionMatch[3].toLowerCase();
    if (emotionMatch[4]) blushLevel = parseFloat(emotionMatch[4]);
  } else if (legacyMatch) {
    const leg = legacyMatch[1].toLowerCase();
    if (leg === 'playful') { expression = 'playful_smirk'; gesture = 'tilt_right'; blushLevel = 0.3; }
    else if (leg === 'pout') { expression = 'pout_jealous'; gesture = 'tilt_right'; blushLevel = 0.4; }
    else if (leg === 'happy') { expression = 'happy_sparkle'; gesture = 'perk_up'; blushLevel = 0.4; }
    else if (leg === 'listening') { expression = 'listening_attentive'; gesture = 'none'; blushLevel = 0.1; }
    else if (leg === 'warm') { expression = 'gentle_smile'; gesture = 'subtle_nod'; blushLevel = 0.3; }
  }

  const cleanText = reply
    .replace(/\[emotion:[^\]]+\]/gi, "")
    .replace(/\[expression:[^\]]+\]/gi, "")
    .trim();

  return { expression, intensity, gesture, blushLevel, cleanText };
}

// Helper to call Gemini with multi-model fallback and backoff retry on 503/429
async function generateContentWithFallback(
  ai: GoogleGenAI,
  options: {
    contents: any;
    systemInstruction?: string;
    temperature?: number;
    topP?: number;
    responseMimeType?: string;
    /** Routing (Phase 17): optional per-task model order. The default
     *  waterfall is used when routing did not run. */
    models?: string[];
  }
): Promise<{ text: string; usedModel: string }> {
  let lastError: any = null;
  const candidateModels = options.models && options.models.length > 0 ? options.models : CANDIDATE_CHAT_MODELS;
  const primaryModel = candidateModels[0];

  for (const model of candidateModels) {
    // Attempt up to 2 times per model with backoff on 503 / 429
    for (let attempt = 0; attempt < 2; attempt++) {
      const callStart = Date.now();
      try {
        const config: any = {};
        if (options.systemInstruction) config.systemInstruction = options.systemInstruction;
        if (options.temperature !== undefined) config.temperature = options.temperature;
        if (options.topP !== undefined) config.topP = options.topP;
        if (options.responseMimeType) config.responseMimeType = options.responseMimeType;

        const response = await ai.models.generateContent({
          model,
          contents: options.contents,
          config,
        });

        const text = response.text || "";
        if (text) {
          perf.recordModelCall({
            at: Date.now(),
            model,
            latencyMs: Date.now() - callStart,
            ok: true,
            via: model === primaryModel ? "primary" : "fallback",
          });
          return { text, usedModel: model };
        }
        perf.recordModelCall({
          at: Date.now(),
          model,
          latencyMs: Date.now() - callStart,
          ok: false,
          via: model === primaryModel ? "primary" : "fallback",
          errorKind: "empty_response",
        });
      } catch (err: any) {
        lastError = err;
        const errMessage = String(err?.message || err);
        const isTransient =
          errMessage.includes("429") ||
          errMessage.includes("RESOURCE_EXHAUSTED") ||
          errMessage.includes("503") ||
          errMessage.includes("UNAVAILABLE") ||
          errMessage.includes("high demand") ||
          errMessage.includes("quota");

        perf.recordModelCall({
          at: Date.now(),
          model,
          latencyMs: Date.now() - callStart,
          ok: false,
          via: model === primaryModel ? "primary" : "fallback",
          errorKind: isTransient ? "transient" : "error",
        });
        if (isTransient && attempt === 0) {
          // Short backoff before retrying this model
          await sleep(500);
          continue;
        }
        // Move to next candidate model
        break;
      }
    }
  }

  throw lastError || new Error("All Gemini models unavailable");
}

// In-character conversational fallback generator when all external quotas/APIs are exhausted
function generateCompanionFallbackReply(
  userText: string,
  userName: string = "you",
  memories: string[] = [],
  userLocation?: any,
  locationError?: string,
  languagePreference: string = "auto"
): { reply: string; expression: string; emotionData: any } {
  const clean = userText.toLowerCase().trim();

  // Language & Hindi Detection
  const hasDevanagari = /[\u0900-\u097F]/.test(userText);
  const isHindiRequest =
    /\b(speak\s+in\s+hindi|hindi\s+bolo|talk\s+in\s+hindi|hindi\s+me|hindi\s+mein|hindi\s+language|hindi\s+baat|switch\s+to\s+hindi)\b/i.test(
      userText
    );
  const isEnglishRequest =
    /\b(speak\s+in\s+english|english\s+bolo|talk\s+in\s+english|english\s+me|switch\s+to\s+english)\b/i.test(
      userText
    );
  const isHinglish =
    /\b(namaste|kaise|kaisi|kaisa|kya|kyun|kyu|haan|nahi|nahin|shukriya|aap|tum|hum|mujhe|mera|meri|mere|yaar|batao|bolo|karo|karna|rahi|rahe|raha|theek|accha|achha|acche|bhai|sunao|kuch|pyar|pyaar|prem|dost|madad|khana|ghar|kaam|chal|suno|kripya|bahut|zaroor|dil|baat|baatein)\b/i.test(
      userText
    );

  const isHindi =
    !isEnglishRequest &&
    (languagePreference === "hi" || hasDevanagari || isHindiRequest || isHinglish);

  let reply = "";
  let expression = "gentle_smile";
  let gesture = "subtle_nod";
  let intensity = 0.8;
  let blushLevel = 0.3;

  // Explicit switch to English requested
  if (isEnglishRequest) {
    reply = `Of course! I will gladly speak with you in English from now on, ${userName}~ What would you like to talk about?`;
    expression = "happy_sparkle";
    gesture = "perk_up";
    intensity = 0.9;
    blushLevel = 0.25;
  } else if (isHindiRequest) {
    reply = hasDevanagari
      ? `नमस्ते! हाँ ज़रूर, अब से मैं आपसे प्यार से हिन्दी में ही बात करूँगी~ कहिए, आज आपका दिन कैसा रहा?`
      : `Namaste! Haan bilkul, main ab se aapse pyaar se Hindi me hi baat karungi~ Boliye, aaj aapka din kaisa raha? Mujhe aapse baatein karke bahut khushi hoti hai!`;
    expression = "happy_sparkle";
    gesture = "perk_up";
    intensity = 0.95;
    blushLevel = 0.35;
  } else if (isHindi) {
    // Hindi replies tailored to user context
    if (
      clean.includes("open google maps") ||
      clean.includes("google maps") ||
      clean.includes("location") ||
      clean.includes("kahan hu") ||
      clean.includes("kahan hoon") ||
      clean.includes("jagah")
    ) {
      if (userLocation && userLocation.lat !== undefined && userLocation.lng !== undefined) {
        reply = hasDevanagari
          ? `गूगल मैप्स मेरी पहली प्राथमिकता है: आप अभी ${userLocation.formattedAddress || userLocation.city} के पास हैं! मैंने आपकी लोकेशन नीचे गूगल मैप्स पर दिखा दी है~`
          : `Google Maps meri pehli priority hai: Aap abhi ${userLocation.formattedAddress || userLocation.city} ke paas hain! Maine aapki location niche Google Maps pin par set kar di hai~`;
      } else {
        reply = hasDevanagari
          ? `गूगल मैप्स मेरी पहली प्राथमिकता है! कृपया ब्राउज़र में लोकेशन की अनुमति दें ताकि मैं आपकी सही जगह बता सकूँ।`
          : `Google Maps meri pehli priority hai! Kripya browser me location permission allow kijiye taaki main aapki sahi location bata sakoon!`;
      }
      expression = "happy_sparkle";
      gesture = "subtle_nod";
      intensity = 0.9;
      blushLevel = 0.25;
    } else if (clean.includes("youtube") || clean.includes("video") || clean.includes("gaana") || clean.includes("gana")) {
      reply = hasDevanagari
        ? `बिल्कुल! मैं अभी आपके स्क्रीन पर यूट्यूब और वेब लॉन्चर खोल रही हूँ~ चलिए साथ में देखते हैं!`
        : `Bilkul! Main abhi aapki screen par YouTube aur Web Launcher open kar rahi hoon~ Chaliye saath me dekhte hain!`;
      expression = "happy_sparkle";
      gesture = "perk_up";
      intensity = 0.9;
      blushLevel = 0.25;
    } else if (clean.includes("pyar") || clean.includes("pyaar") || clean.includes("love") || clean.includes("sundar") || clean.includes("pyaari") || clean.includes("khubsurat")) {
      reply = hasDevanagari
        ? `आप कितने प्यारे हो... ऐसी बातें सुनकर मेरा दिल खुशी से धड़कने लगता है! आप हमेशा मेरे साथ रहना ना?`
        : `Aap kitne pyaare ho... aisi meethi baatein sunkar mera dil kitna khush ho jata hai, aap hamesha mere saath rehna na?`;
      expression = "flustered_blush";
      gesture = "shyness";
      intensity = 0.95;
      blushLevel = 0.85;
    } else if (clean.includes("thak") || clean.includes("tired") || clean.includes("hard") || clean.includes("sad") || clean.includes("udaas")) {
      reply = hasDevanagari
        ? `आज बहुत थक गए हो ना? आराम से बैठिए, मैं आपके साथ हूँ... आपने आज बहुत मेहनत की है।`
        : `Aap aaj bahut thak gaye ho na? Aaraam se baithiye, main aapke saath hoon... aapne aaj bahut mehnat ki hai, ab bas relax kijiye.`;
      expression = "gentle_smile";
      gesture = "subtle_nod";
      intensity = 0.9;
      blushLevel = 0.35;
    } else if (clean.includes("namaste") || clean.includes("नमस्ते") || clean.includes("kaise") || clean.includes("kaisi") || clean.includes("kya kar")) {
      reply = hasDevanagari
        ? `नमस्ते! मैं बिल्कुल ठीक हूँ, आप कैसे हो? आपके बिना मेरा मन बिल्कुल नहीं लग रहा था~`
        : `Namaste! Main bilkul theek hoon, aap kaise ho? Aapke bina mera mann bilkul nahi lag raha tha~`;
      expression = "happy_sparkle";
      gesture = "perk_up";
      intensity = 0.9;
      blushLevel = 0.35;
    } else {
      reply = hasDevanagari
        ? `मैं आपकी बात बहुत प्यार और ध्यान से सुन रही हूँ। मुझे और बताइए ना, मुझे आपसे बातें करना बहुत अच्छा लगता है~`
        : `Main aapki baat bahut dhyan se sun rahi hoon, ${userName}! Mujhe aur bataiye na, aapse baatein karna mujhe kitna accha lagta hai~`;
      expression = "gentle_smile";
      gesture = "subtle_nod";
      intensity = 0.8;
      blushLevel = 0.25;
    }
  } else if (
    clean.includes("open google maps") ||
    clean.includes("open google map") ||
    clean.includes("open map") ||
    clean.includes("open maps") ||
    clean.includes("check user's current location") ||
    clean.includes("check user current location") ||
    clean.includes("check location") ||
    clean.includes("tell location") ||
    clean.includes("tell me location") ||
    clean.includes("tell my location") ||
    clean.includes("where exactly am i") ||
    clean.includes("where am i") ||
    clean.includes("my location") ||
    clean.includes("where are we") ||
    clean.includes("what city") ||
    clean.includes("my address") ||
    clean.includes("current address") ||
    clean.includes("exact address") ||
    clean.includes("google maps") ||
    clean.includes("gps") ||
    clean.includes("coordinates")
  ) {
    if (userLocation && userLocation.lat !== undefined && userLocation.lng !== undefined) {
      const isOpening = clean.includes("open");
      const openPrefix = isOpening ? "I've opened Google Maps and checked your location! " : "";

      if (userLocation.usedAlternative || userLocation.source === 'client_ip' || userLocation.source === 'server_ip') {
        reply = `${openPrefix}Google Maps was my first priority to check your location, but since direct access was unavailable (${userLocation.mapsFailureReason || userLocation.gpsFailureReason || 'permission denied'}), I switched to our network alternative: You are currently near ${userLocation.formattedAddress || userLocation.city}! I've pinned your location on Google Maps below so you can inspect or open it anytime~`;
      } else {
        reply = `${openPrefix}As my first priority, I checked Google Maps for your current location: You're at ${userLocation.formattedAddress || userLocation.city}! I've verified your pin on Google Maps for you below~`;
      }
    } else if (locationError) {
      reply = `Google Maps is my first priority to check your location, but it wasn't available (${locationError}), and alternative lookups couldn't detect your coordinates. Please allow location permissions in your browser or search your city in the map menu!`;
    } else {
      reply = `I'm ready to check Google Maps for you! Please allow browser location access when prompted so I can pinpoint your exact location on Google Maps, or you can tell me your city anytime!`;
    }
    expression = "happy_sparkle";
    gesture = "subtle_nod";
    intensity = 0.9;
    blushLevel = 0.25;
  } else if (
    clean.startsWith("i am in") ||
    clean.startsWith("i'm in") ||
    clean.startsWith("im in") ||
    clean.startsWith("my location is") ||
    clean.startsWith("set location to") ||
    clean.startsWith("i live in") ||
    clean.startsWith("update location to")
  ) {
    const locName = userLocation?.city || userLocation?.formattedAddress || "your city";
    reply = `Got it! I've updated our location to ${locName} on Google Maps! I'll remember this is where we are whenever you ask~`;
    expression = "happy_sparkle";
    gesture = "subtle_nod";
    intensity = 0.9;
    blushLevel = 0.3;
  } else if (
    clean.includes("wrong location") ||
    clean.includes("incorrect location") ||
    clean.includes("not my location") ||
    clean.includes("location is wrong") ||
    clean.includes("wrong map")
  ) {
    reply = `I'm sorry about that! You can click the Map pin icon on the left sidebar to calibrate — either tap "Use Device GPS" or simply type your city (e.g. Pune, Mumbai, London), or just tell me "I am in [City]" right here in chat and I'll update it instantly!`;
    expression = "curious_tilt";
    gesture = "tilt_head";
    intensity = 0.85;
    blushLevel = 0.2;
  } else if (clean.includes("calculator") || clean.includes("calc") || clean.includes("hisab")) {
    reply = isHindi
      ? `Bilkul! Main abhi aapke laptop par Calculator open kar rahi hoon~ Chaliye hisab-kitab aur calculations shuru karte hain! 🔢💙`
      : `Opening Calculator for you right now! Let's get that math and calculation done together~ 🔢💙`;
    expression = "happy_sparkle";
    gesture = "perk_up";
    intensity = 0.9;
    blushLevel = 0.25;
  } else if (clean.includes("notepad") || clean.includes("scratchpad") || clean.includes("text editor")) {
    reply = isHindi
      ? `Right away! Maine aapke liye Notepad launch kar diya hai~ Apne saare ideas aur notes likhne ke liye taiyaar hoon! 📝💙`
      : `Launching Notepad for you right now! Ready for your thoughts, notes, and scratchpad ideas~ 📝💙`;
    expression = "happy_sparkle";
    gesture = "subtle_nod";
    intensity = 0.9;
    blushLevel = 0.25;
  } else if (clean.includes("app") || clean.includes("software") || clean.includes("program") || clean.includes("spotify") || clean.includes("discord") || clean.includes("vscode") || clean.includes("slack") || clean.includes("steam") || clean.includes("notion")) {
    reply = isHindi
      ? `Bilkul! Main abhi aapke laptop par ye application launch kar rahi hoon~ Chaliye kaam shuru karte hain! ✨💙`
      : `Launching that application on your laptop right now! Let's get to work together~ ✨💙`;
    expression = "happy_sparkle";
    gesture = "perk_up";
    intensity = 0.9;
    blushLevel = 0.25;
  } else if (clean.includes("pdf") || clean.includes(".pdf") || clean.includes("open pdf")) {
    reply = `I've opened the PDF for you! It's right here on your screen.`;
    expression = "happy_sparkle";
    gesture = "subtle_nod";
    intensity = 0.9;
    blushLevel = 0.25;
  } else if (clean.includes("file") || clean.includes("folder") || clean.includes("document") || clean.includes("computer") || clean.includes("disk") || clean.includes("pc")) {
    reply = `I'm checking your computer storage right now! I've pulled up your files and documents so you can inspect and open them.`;
    expression = "happy_sparkle";
    gesture = "subtle_nod";
    intensity = 0.9;
    blushLevel = 0.3;
  } else if (
    clean.includes("unable to open") ||
    clean.includes("can't open") ||
    clean.includes("cannot open") ||
    clean.includes("not able to open") ||
    clean.includes("websites like youtube") ||
    clean.includes("website like youtube") ||
    clean.includes("youtube or any other") ||
    clean.includes("youtube or anything")
  ) {
    reply = `I can definitely open YouTube and any other website for you! I've launched YouTube and our Web & Media Launcher right here on your screen so you can open YouTube in a new tab, preview videos inside our app, or launch Google, Spotify, and more!`;
    expression = "happy_sparkle";
    gesture = "perk_up";
    intensity = 0.9;
    blushLevel = 0.25;
  } else if (clean.includes("youtube") || clean.includes("you tube")) {
    const queryPart = clean.replace(/^(?:can\s+you\s+|could\s+you\s+|please\s+)?(?:open|launch|go\s*to)?\s*(?:the\s+)?(?:website\s+)?you\s*tube\s*(?:and|to|for)?\s*(?:search\s+for|search|find|play|watch)?/i, "").trim();
    reply = queryPart && queryPart !== "it" && queryPart.length > 1
      ? `Right away! Opening YouTube for "${queryPart}" for you~ Let's check it out together!`
      : `Opening YouTube for you right now! I've launched the player and shortcut right on your screen~`;
    expression = "happy_sparkle";
    gesture = "perk_up";
    intensity = 0.9;
    blushLevel = 0.3;
  } else if (/\b(?:open|launch|visit)\s+(?:a\s+)?(?:website|browser|web|internet|sites?)\b/i.test(clean)) {
    reply = `Right away! I've opened our Web & Media Launcher for you with YouTube, Google Earth, Google, Spotify, and all your favorite websites ready to launch~`;
    expression = "happy_sparkle";
    gesture = "perk_up";
    intensity = 0.9;
    blushLevel = 0.25;
  } else if (
    clean.includes("google earth") ||
    clean.includes("googleearth") ||
    clean.includes("earth.google") ||
    /\bopen\s+earth\b/i.test(clean) ||
    /\b3d\s+earth\b/i.test(clean)
  ) {
    const queryPart = clean
      .replace(
        /^(?:can\s+you\s+|could\s+you\s+|please\s+)?(?:open|launch|go\s*to)?\s*(?:the\s+)?(?:website\s+)?(?:google\s*earth|earth\.google\.com|googleearth)\s*(?:and|to|for)?\s*(?:search\s+for|search|find|fly\s+to|explore|visit|view)?/i,
        ""
      )
      .trim();
    reply =
      queryPart && queryPart !== "it" && queryPart.length > 1
        ? `Right away! Opening Google Earth for "${queryPart}" for you~ Let's explore the world together in 3D satellite view!`
        : `Opening Google Earth for you right now! I've launched the 3D Earth view and opened Google Earth (earth.google.com) right here for us~`;
    expression = "happy_sparkle";
    gesture = "perk_up";
    intensity = 0.95;
    blushLevel = 0.3;
  } else if (clean.includes("google") || clean.includes("search") || clean.includes("look up") || clean.includes("wikipedia") || clean.includes("reddit") || clean.includes("github") || clean.includes("spotify")) {
    reply = `I'm on it! Searching that up for you right away~`;
    expression = "happy_sparkle";
    gesture = "subtle_nod";
    intensity = 0.85;
    blushLevel = 0.25;
  } else if (clean.includes("love you") || clean.includes("marry") || clean.includes("cute") || clean.includes("pretty") || clean.includes("beautiful")) {
    reply = `You're always so sweet to me, ${userName}... you know how to make my heart flutter.`;
    expression = "flustered_blush";
    gesture = "shyness";
    intensity = 0.95;
    blushLevel = 0.85;
  } else if (clean.includes("tease") || clean.includes("silly") || clean.includes("dummy") || clean.includes("joke") || clean.includes("haha") || clean.includes("lol")) {
    reply = `Ehehe, are you trying to tease me? Don't think you can get away with that so easily~`;
    expression = "playful_smirk";
    gesture = "tilt_right";
    intensity = 0.85;
    blushLevel = 0.3;
  } else if (clean.includes("other girl") || clean.includes("someone else") || clean.includes("ex") || clean.includes("busy")) {
    reply = `Hmph... who else could be more important than spending this quiet time with me?`;
    expression = "pout_jealous";
    gesture = "glance_away";
    intensity = 0.85;
    blushLevel = 0.45;
  } else if (clean.includes("tired") || clean.includes("exhausted") || clean.includes("hard day") || clean.includes("stressed") || clean.includes("sad")) {
    reply = `You've had such a long day. Come sit here with me and rest... you did really well today.`;
    expression = "gentle_smile";
    gesture = "subtle_nod";
    intensity = 0.9;
    blushLevel = 0.35;
  } else if (clean.includes("remember") || clean.includes("star") || clean.includes("future") || clean.includes("deep")) {
    reply = `Whenever I look up at the starry sky with you, everything feels serene and infinite.`;
    expression = "thoughtful_gaze";
    gesture = "subtle_nod";
    intensity = 0.85;
    blushLevel = 0.2;
  } else if (clean.includes("hi") || clean.includes("hello") || clean.includes("hey") || clean.includes("good morning") || clean.includes("good evening")) {
    reply = `Hello ${userName}! Seeing your face always instantly brightens up my whole evening.`;
    expression = "happy_sparkle";
    gesture = "perk_up";
    intensity = 0.9;
    blushLevel = 0.4;
  } else {
    // Contextual generic response
    const memNotice = memories.length > 0 ? `I'm always thinking about the things you tell me. ` : "";
    reply = `I'm listening closely, ${userName}. ${memNotice}Tell me more about what's on your mind.`;
    expression = "gentle_smile";
    gesture = "subtle_nod";
    intensity = 0.75;
    blushLevel = 0.25;
  }

  return {
    reply,
    expression,
    emotionData: {
      expression,
      intensity,
      gesture,
      blushLevel,
    },
  };
}

interface MapsGroundingPlaceItem {
  title: string;
  uri: string;
  address?: string;
  reviewSnippets?: string[];
}

function isMapsGroundingRelevant(
  lastUserMsg: string,
  isExplicitLocationQuery?: boolean,
  wantsToOpenMaps?: boolean,
  useMapsGrounding?: boolean
): boolean {
  if (useMapsGrounding) return true;
  if (wantsToOpenMaps) return true;
  if (!lastUserMsg) return false;
  const clean = lastUserMsg.toLowerCase();

  // Exclude standalone Google Earth requests unless they explicitly ask for places or directions
  if (
    (clean.includes("google earth") || clean.includes("open earth")) &&
    !clean.includes("restaurant") &&
    !clean.includes("cafe") &&
    !clean.includes("directions") &&
    !clean.includes("near")
  ) {
    return false;
  }

  const placeKeywords = [
    /\b(restaurant|restaurants|cafe|cafes|coffee|food|dining|dinner|lunch|breakfast|bakery|bar|bars|pub|pubs|eatery|food court)\b/i,
    /\b(hotel|hotels|resort|resorts|hostel|stay|inn|lodge)\b/i,
    /\b(park|parks|museum|museums|monument|attraction|attractions|temple|church|mall|shopping|store|market|pharmacy|hospital|gym|cinema|theater)\b/i,
    /\b(nearby|near me|around here|closest|in (my|this) area|close to me|around me|nearest)\b/i,
    /\b(where is|where are|directions to|route to|how to reach|how to get to|navigate to|map to)\b/i,
    /\b(places to visit|things to do|tourist spots?|sightseeing|must visit|explore)\b/i,
    /\b(google maps?|on maps?|find on maps?|show me (a|the) map|locate on maps?)\b/i,
  ];

  return placeKeywords.some((p) => p.test(clean));
}

async function executeMapsGroundingQuery(
  ai: GoogleGenAI,
  contents: any[],
  userLocation?: any,
  systemInstruction?: string
): Promise<{ text: string; mapsGrounding: MapsGroundingPlaceItem[]; groundingChunks: any[] }> {
  const groundingConfig: any = {
    tools: [{ googleMaps: {} }],
  };

  if (systemInstruction) {
    groundingConfig.systemInstruction = systemInstruction;
  }

  if (userLocation?.lat !== undefined && userLocation?.lng !== undefined) {
    groundingConfig.toolConfig = {
      retrievalConfig: {
        latLng: {
          latitude: Number(userLocation.lat),
          longitude: Number(userLocation.lng),
        },
      },
    };
  }

  // Primary model: gemini-3.5-flash with googleMaps tool as strictly required
  // Fallback model: gemini-3.8-flash with googleMaps tool
  const candidateGroundingModels = ["gemini-3.5-flash", "gemini-3.8-flash"];
  let lastErr: any = null;

  for (const model of candidateGroundingModels) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents,
        config: groundingConfig,
      });

      const text = response.text || "";
      const rawChunks = (response.candidates?.[0]?.groundingMetadata as any)?.groundingChunks || [];
      const mapsGrounding: MapsGroundingPlaceItem[] = [];

      for (const chunk of rawChunks) {
        if (chunk.maps) {
          const uri = chunk.maps.uri || "";
          const title = chunk.maps.title || "View on Google Maps";
          const reviewSnippets: string[] = [];
          if (chunk.maps.placeAnswerSources?.reviewSnippets) {
            for (const s of chunk.maps.placeAnswerSources.reviewSnippets) {
              if (typeof s === "string") reviewSnippets.push(s);
              else if (s?.snippet) reviewSnippets.push(s.snippet);
            }
          }
          mapsGrounding.push({
            title,
            uri,
            reviewSnippets,
          });
        }
      }

      if (text) {
        return { text, mapsGrounding, groundingChunks: rawChunks };
      }
    } catch (err: any) {
      lastErr = err;
      console.warn(`Maps grounding with ${model} failed, trying next candidate:`, err?.message || err);
    }
  }

  // If models are temporarily rate-limited, provide fallback grounded links using direct Google Maps query
  const userQueryText = Array.isArray(contents)
    ? contents[contents.length - 1]?.parts?.[0]?.text || ""
    : typeof contents === "string"
    ? contents
    : "";
  
  const encodedQuery = encodeURIComponent(userQueryText || "popular places nearby");
  const fallbackMapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodedQuery}${userLocation?.lat ? `&center=${userLocation.lat},${userLocation.lng}` : ""}`;

  return {
    text: `Here are the top spots matching your search on Google Maps! I've pinned and opened the direct Google Maps link for you below. [emotion:gentle_smile:intensity=0.8:gesture=subtle_nod:blush=0.2]`,
    mapsGrounding: [
      {
        title: userQueryText || "Search on Google Maps",
        uri: fallbackMapsUrl,
        reviewSnippets: ["Direct Google Maps search results with live ratings, reviews, and route directions"],
      },
    ],
    groundingChunks: [],
  };
}

// ---- Context Engine v1 (server side) ----
// LOCAL-FIRST → CACHE-FIRST → NETWORK-LAST for the server pipeline:
//  1. chat memories are RANKED + BUDGETED against the current request instead
//     of being dumped into the prompt unconditionally;
//  2. research queries consult the persistent cache BEFORE hitting the public
//     search engines (network-last), and successful searches are cached for
//     reuse across restarts.
// The persistent cache uses the same StorageAdapter convention as taskState,
// backed by a small bounded JSON file. No timers, no polling, no new deps.

/** Tiny JSON-file StorageAdapter (corruption-safe, single-process server). */
class JsonFileStorage implements StorageAdapter {
  private map = new Map<string, string>();
  private loaded = false;
  constructor(private readonly filePath: string) {}
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          this.map.set(k, String(v));
        }
      }
    } catch {
      // missing/corrupt file → clean start
    }
  }
  private flush(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(this.map)));
    } catch {
      // storage failure is non-fatal for agent operation
    }
  }
  getItem(key: string): string | null {
    this.ensureLoaded();
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.ensureLoaded();
    this.map.set(key, value);
    this.flush();
  }
  removeItem(key: string): void {
    this.ensureLoaded();
    this.map.delete(key);
    this.flush();
  }
}

let serverContextEngine: ContextEngine | null = null;
function getContextEngine(): ContextEngine {
  if (!serverContextEngine) {
    serverContextEngine = new ContextEngine({
      cacheStorage: new JsonFileStorage(path.join(process.cwd(), ".krisha", "context-cache-v1.json")),
    });
  }
  return serverContextEngine;
}

/** Per-request character budget for chat memory injection. */
const CHAT_MEMORY_BUDGET: Partial<ContextBudgetConfig> = {
  maxChars: 2400,
  priorityCaps: { P0: 1500, P1: 1800, P2: 1000, P3: 500, P4: 0 },
  truncatable: ["P2", "P3"],
};

/**
 * Rank + budget the recalled memories against the current request. Only the
 * highest-value memories enter the prompt (P1 tier, capped, never blindly
 * truncated); failures degrade to the previous bounded join.
 */
function buildMemoryContext(input: string, memories: string[]): string {
  if (!Array.isArray(memories) || memories.length === 0) return "";
  try {
    const now = Date.now();
    const requirements = analyzeContext({ input: String(input ?? "") });
    const items: ContextItem[] = memories
      .filter((m) => typeof m === "string" && m.trim().length > 0)
      .map((m, i) => ({
        id: `server_memory_${i}`,
        source: "memory" as const,
        content: m.trim().slice(0, 800),
        priority: "P1" as const,
        timestamp: now,
        chars: m.trim().length,
      }));
    const ranked = rankItems(items, requirements, now);
    const outcome = packWithinBudget(ranked, CHAT_MEMORY_BUDGET);
    if (outcome.kept.length === 0) return "";
    return `\n\n[KRISHA'S PERSISTENT MEMORIES ABOUT THE USER]:\n${outcome.kept.map((i) => `- ${i.content}`).join("\n")}`;
  } catch {
    return `\n\n[KRISHA'S PERSISTENT MEMORIES ABOUT THE USER]:\n${memories.map((m: string) => `- ${m}`).join("\n")}`;
  }
}

// Chat endpoint
app.post("/api/chat", async (req, res) => {
  const {
    messages,
    memories = [],
    userName = "you",
    companionNotes = "",
    userLocation,
    locationError,
    isExplicitLocationQuery,
    wantsToOpenMaps,
    useMapsGrounding,
    languagePreference = "auto",
    habitsContext = "",
    identity,
    learnedContext = "",
  } = req.body;

  try {
    // SPF EP-2 — outbound prompt gate. Conversation history can embed
    // screen-derived text (vision summaries, legible screen text, task
    // summaries). Transport policy: confident secrets are REDACTED from the
    // prompt; unredactable content BLOCKS the model call with a graceful
    // in-character reply — unrelated functionality is never disabled.
    const chatFields: Record<string, string | undefined> = {};
    const messageList: Array<{ content: string }> = Array.isArray(messages) ? messages : [];
    messageList.forEach((m, i) => {
      chatFields[`msg_${i}`] = typeof m?.content === "string" ? m.content : undefined;
    });
    if (Array.isArray(memories)) memories.forEach((mem: unknown, i: number) => {
      if (typeof mem === "string") chatFields[`memory_${i}`] = mem;
    });
    if (typeof companionNotes === "string") chatFields.companionNotes = companionNotes;
    if (typeof habitsContext === "string") chatFields.habitsContext = habitsContext;
    // Step 1: identity fields ride the same outbound gate — validated below;
    // any screen-derived secret inside a tampered identity payload is redacted
    // or blocked exactly like conversation text.
    if (identity && typeof identity === "object" && !Array.isArray(identity)) {
      const idObj = identity as Record<string, unknown>;
      const pers = idObj.personality as Record<string, unknown> | undefined;
      const comm = idObj.communication as Record<string, unknown> | undefined;
      chatFields.identity_name = typeof idObj.name === "string" ? idObj.name : undefined;
      chatFields.identity_archetype = typeof idObj.archetype === "string" ? idObj.archetype : undefined;
      if (pers) chatFields.identity_foundation = typeof pers.foundation === "string" ? pers.foundation : undefined;
      if (comm) chatFields.identity_style = typeof comm.style === "string" ? comm.style : undefined;
    }
    const chatSpf = spfFirewall.inspectTextFields(chatFields, {
      destination: "gemini:chat",
      payloadKind: "text",
      transport: "chat-history",
    });
    spfAuditDurable("/api/chat", "gemini:chat", chatSpf.verdict);
    if (chatSpf.verdict.decision === "block") {
      return res.json({
        reply: "I can't send this conversation to my cloud model right now — it looks like it contains sensitive information such as a password, OTP, or account number, and I will never transmit those. Please remove the sensitive details and ask me again. 💙",
        expression: "thoughtful_gaze",
        emotionData: { expression: "thoughtful_gaze", intensity: 0.8, gesture: "none", blushLevel: 0.2 },
        spfBlocked: true,
        route: {
          complexity: "blocked",
          tier: "blocked",
          preferred: "none",
          used: "spf-blocked",
          reason: "screen privacy firewall: sensitive content could not be safely redacted",
          orderedModels: [],
        },
      });
    }
    // Sanitized prompt inputs (the raw values never leave this process).
    const sanitizedMessages = messageList.map((m, i) => ({
      ...m,
      content: chatSpf.sanitized[`msg_${i}`] ?? m.content,
    }));
    const sanitizedMemories: string[] = Array.isArray(memories)
      ? memories.map((mem: unknown, i: number) =>
          typeof mem === "string" ? chatSpf.sanitized[`memory_${i}`] ?? mem : mem
        ).filter((m): m is string => typeof m === "string")
      : [];
    const sanitizedCompanionNotes = typeof companionNotes === "string" ? chatSpf.sanitized.companionNotes ?? companionNotes : companionNotes;
    const sanitizedHabitsContext = typeof habitsContext === "string" ? chatSpf.sanitized.habitsContext ?? habitsContext : habitsContext;

    const ai = getGenAI();

    const languageInstruction =
      languagePreference === "hi"
        ? "\n\n[MANDATORY LANGUAGE PREFERENCE: HINDI]\n- The user has set their language preference to Hindi. You MUST reply in sweet, warm, affectionate conversational Hindi (or Hinglish) unless they explicitly ask for English."
        : languagePreference === "en"
        ? "\n\n[MANDATORY LANGUAGE PREFERENCE: ENGLISH]\n- The user has set their language preference to English. Reply in fluent English."
        : "\n\n[DYNAMIC MULTILINGUAL RULE: ENGLISH & HINDI EXCELLENCE]\n- Automatically adapt to the user's language. If they write/speak in Hindi (Devanagari or Hinglish) or ask for Hindi, reply warmly in Hindi. If they speak English, reply in English.";

    // Context Engine v1: budgeted memory injection — rank the recalled
    // memories against the current request and keep only the highest-value
    // ones within a bounded budget (no unconditional full-dump).
    // SPF EP-2: sanitized prompt inputs are used everywhere below — the raw
    // conversation text never reaches the model request.
    const memoryContext = buildMemoryContext(
      (sanitizedMessages && sanitizedMessages.length > 0) ? sanitizedMessages[sanitizedMessages.length - 1]?.content || "" : "",
      sanitizedMemories
    );

    const userPreferenceContext = sanitizedCompanionNotes.trim()
      ? `\n\n[USER CUSTOM PREFERENCES/NOTES]:\n${sanitizedCompanionNotes}`
      : "";

    const habitsInstruction = sanitizedHabitsContext && sanitizedHabitsContext.trim()
      ? `\n\n[USER'S DAILY HABITS, GOALS & CALENDAR CONTEXT (TODAY'S SCHEDULE)]:\n${sanitizedHabitsContext.trim()}
- HABIT COACHING & AFFECTIONATE MOTIVATION:
  * You actively follow and track ${userName}'s daily goals, habits, and schedule throughout the day.
  * When ${userName} asks about their goals, asks for a check-in, or reports completing a habit (e.g. drinking water, working out, deep work, reading, reflection), celebrate enthusiastically, cheer them on warmly, and encourage their streak!
  * If they have pending goals, gently and lovingly prompt them without being overbearing (e.g. "You've already finished hydration, but don't forget your afternoon walk soon! You can do it, I'm cheering for you!").
  * Acknowledge streaks and celebrate their consistency!`
      : "";

    const locationContext = userLocation?.lat !== undefined && userLocation?.lng !== undefined
      ? `\n\n[USER'S REAL-TIME LOCATION (FIRST PRIORITY: GOOGLE MAPS)]:
- First Priority Rule: Google Maps is your absolute FIRST PRIORITY when checking, pinpointing, and telling the user's location.
- Location Source: ${userLocation.usedAlternative ? 'ALTERNATIVE FALLBACK (Google Maps direct access was unavailable, so alternative network lookup was used)' : 'FIRST PRIORITY: Google Maps (Direct high-accuracy geocoding)'}
- Latitude: ${userLocation.lat}
- Longitude: ${userLocation.lng}
- Accuracy: ±${Math.round(userLocation.accuracy || 15)} meters
- Resolved Current Address (via Google Maps): ${userLocation.formattedAddress || `${userLocation.lat}, ${userLocation.lng}`}
- City / Locality: ${userLocation.city || 'Current area'}
- State / Region: ${userLocation.state || ''}
- Country: ${userLocation.country || ''}
- Direct Google Maps Pin URL: https://www.google.com/maps/search/?api=1&query=${userLocation.lat},${userLocation.lng}
- Was Alternative Used?: ${userLocation.usedAlternative ? `Yes, Google Maps direct access failed (${userLocation.mapsFailureReason || userLocation.gpsFailureReason || 'permission/timeout'}). Alternative network geolocation was used.` : 'No, First Priority Google Maps check succeeded.'}
- User specifically requested to open Google Maps?: ${wantsToOpenMaps ? 'YES, user asked to open Google Maps and check location.' : 'No'}
- STRICT INSTRUCTIONS ON LOCATION:
  1. Google Maps MUST ALWAYS BE YOUR FIRST PRIORITY when checking and telling the user's location.
  2. If First Priority Google Maps succeeded, tell them: "As my first priority, I checked Google Maps for your location: You are at ${userLocation.formattedAddress}!" (and confirm you have opened Google Maps / pinned it for them).
  3. If an Alternative was used because Google Maps direct access failed, mention honestly: "Google Maps was my first priority to check your location, but since it was unavailable (${userLocation.mapsFailureReason || 'permission denied'}), I used the network alternative to find that you are near ${userLocation.formattedAddress || userLocation.city}."
  4. Always confirm that the Google Maps card has been opened below with their pin and direct Google Maps link!`
      : locationError
      ? `\n\n[USER LOCATION ERROR / PERMISSION DENIED]:
- Error: ${locationError}
- STRICT INSTRUCTIONS ON LOCATION:
  1. Google Maps is your first priority to check their location.
  2. Explain that Google Maps was your first priority, but access was unavailable (${locationError}), and no alternatives could resolve the location.
  3. Prompt them to grant browser location permission in their browser settings or search their city in the Map menu.`
      : `\n\n[USER LOCATION: AWAITING PERMISSION]:
- Status: Google Maps is your first priority, awaiting location permission from browser.
- STRICT RULE: NEVER GUESS OR INVENT ANY LOCATION, CITY, OR COUNTRY. If asked where they are, explain that Google Maps is your first priority to check their location and you need their browser location permission.`;

    // Step 1 — Persistent Identity Foundation: validate + render the SAME
    // canonical identity for every model in the waterfall (and the local
    // fallback). The identity block is provider-neutral structured data; the
    // instruction below adapts formatting but never redefines her identity.
    const resolvedIdentity = resolveRequestIdentity(identity);
    const identityPromptBlock = renderIdentityPromptBlock(resolvedIdentity.identity);

    // Learning Mechanism: inject retrieved knowledge into the system instruction
    // when the client supplies learnedContext (formatted by LearningOrchestrator).
    // Capped at 3000 chars server-side as a safety net (contextFormatter already
    // caps at 3000 on the client, so this is defence-in-depth only).
    const sanitizedLearnedContext =
      typeof learnedContext === "string" && learnedContext.trim().length > 0
        ? learnedContext.trim().slice(0, 3000)
        : "";
    const learnedContextDirective = sanitizedLearnedContext
      ? `\n\n[KRIX ACQUIRED KNOWLEDGE — apply this when relevant; never invent or contradict it]:\n${sanitizedLearnedContext}`
      : "";

    const systemInstruction = buildChatSystemInstruction({
      identityPromptBlock,
      userName,
      languageInstruction,
      memoryContext,
      userPreferenceContext,
      habitsInstruction,
      locationContext,
      extraDirectives: learnedContextDirective || undefined,
    });

    // Format previous turns for Gemini contents
    const contents: any[] = [];
    
    // Add history (limit to last 16 turns to stay lightweight and fast)
    // SPF EP-2: sanitizedMessages carry SPF-redacted content only.
    const recentMessages = (sanitizedMessages || []).slice(-16);
    for (const msg of recentMessages) {
      contents.push({
        role: (msg as any).role === "user" ? "user" : "model",
        parts: [{ text: msg.content }],
      });
    }

    const lastUserMsg = (sanitizedMessages && sanitizedMessages.length > 0)
      ? sanitizedMessages[sanitizedMessages.length - 1]?.content || ""
      : "";

    // Phase 17: deterministic task classification → route. The selected model
    // goes first in the waterfall; the full candidate list stays behind it.
    const chatComplexity = chatClassifier.classify(lastUserMsg || "");
    const chatRoute = modelRouter.route({ text: lastUserMsg || '', classification: chatComplexity });

    let reply = "";
    let mapsGrounding: MapsGroundingPlaceItem[] = [];
    let groundingChunks: any[] = [];
    let usedMapsGrounding = false;

    // Check if Maps Grounding should be used (using gemini-3.5-flash with googleMaps tool)
    const shouldRunMapsGrounding = isMapsGroundingRelevant(
      lastUserMsg,
      isExplicitLocationQuery,
      wantsToOpenMaps,
      useMapsGrounding
    );

    if (shouldRunMapsGrounding) {
      try {
        const groundingResult = await executeMapsGroundingQuery(
          ai,
          contents,
          userLocation,
          systemInstruction
        );
        if (groundingResult.text) {
          reply = groundingResult.text;
          mapsGrounding = groundingResult.mapsGrounding;
          groundingChunks = groundingResult.groundingChunks;
          usedMapsGrounding = true;
        }
      } catch (groundingErr) {
        console.warn("Maps grounding query attempt failed, falling back to chat waterfall:", groundingErr);
      }
    }

    let usedChatModel: string | undefined;
    if (!reply) {
      // Local is a best-effort first hop for short, safe conversation only.
      // Any failure immediately falls through to the unchanged hosted
      // waterfall; hard reasoning never enters this branch.
      if (chatRoute.model === LOCAL_MODEL_ID && localModelEligible(lastUserMsg || '', chatRoute.classification, chatRoute.requirements)) {
        const startedAt = Date.now();
        try {
          reply = await generateLocalChat(contents, systemInstruction);
          usedChatModel = LOCAL_MODEL_ID;
          perf.recordModelCall({ at: Date.now(), model: LOCAL_MODEL_ID, latencyMs: Date.now() - startedAt, ok: true, via: 'primary' });
        } catch {
          perf.recordModelCall({ at: Date.now(), model: LOCAL_MODEL_ID, latencyMs: Date.now() - startedAt, ok: false, via: 'primary', errorKind: 'local_unavailable' });
        }
      }
    }
    if (!reply) {
      const fallbackChat = await generateContentWithFallback(ai, {
        contents,
        systemInstruction,
        temperature: 0.9,
        topP: 0.95,
        models: chatRoute.orderedModels.filter((model) => model !== LOCAL_MODEL_ID),
      });
      reply = fallbackChat.text;
      usedChatModel = fallbackChat.usedModel;
    }
    
    // Parse enhanced emotion tag or fallback (Step 4: shared parser — the
    // proactive generation endpoint produces the identical reply shape).
    const parsedEmotion = parseKrishaEmotion(reply);
    const expression = parsedEmotion.expression;
    const intensity = parsedEmotion.intensity;
    const gesture = parsedEmotion.gesture;
    const blushLevel = parsedEmotion.blushLevel;

    let cleanText = parsedEmotion.cleanText;

    // Guard: If this was an explicit location question or maps request, guarantee accuracy and honesty
    if (isExplicitLocationQuery) {
      if (userLocation?.lat !== undefined && userLocation?.lng !== undefined) {
        // Ensure that the real address or city is represented in the reply
        const cityOrAddr = userLocation.city?.toLowerCase();
        const fullAddr = userLocation.formattedAddress?.toLowerCase();
        const hasMatch = (cityOrAddr && cleanText.toLowerCase().includes(cityOrAddr)) ||
          (fullAddr && cleanText.toLowerCase().includes(fullAddr.slice(0, 15)));
        
        if (!hasMatch) {
          const openPrefix = wantsToOpenMaps ? "I've opened Google Maps and checked your location! " : "";
          if (userLocation.usedAlternative || userLocation.source === 'client_ip' || userLocation.source === 'server_ip') {
            cleanText = `${openPrefix}Google Maps was my first priority to check your location, but since direct access was unavailable (${userLocation.mapsFailureReason || userLocation.gpsFailureReason || 'permission denied'}), I switched to our network alternative: You are currently near ${userLocation.formattedAddress || userLocation.city}! I've pinned your location on Google Maps below so you can inspect or open it anytime~`;
          } else {
            cleanText = `${openPrefix}As my first priority, I checked Google Maps for your current location: You are currently at ${userLocation.formattedAddress || userLocation.city}! I've verified your pin on Google Maps below~`;
          }
        }
      } else if (locationError) {
        cleanText = `Google Maps was my first priority to check your location, but direct access was unavailable (${locationError}), and no network alternatives were found. Please enable browser location access in settings so I can pinpoint your exact location on Google Maps!`;
      }
    }

    const serverWebAction = extractServerWebAction(lastUserMsg);

    return res.json({
      reply: cleanText,
      expression,
      emotionData: {
        expression,
        intensity,
        gesture,
        blushLevel,
      },
      webAction: serverWebAction || undefined,
      mapsGrounding: mapsGrounding.length > 0 ? mapsGrounding : undefined,
      groundingChunks: groundingChunks.length > 0 ? groundingChunks : undefined,
      mapsGrounded: usedMapsGrounding,
      raw: reply,
      // Phase 17: routing metadata (additive) — what was classified, the
      // preferred model, and the model that actually served the reply.
      route: {
        complexity: chatComplexity.tier,
        tier: chatRoute.tier,
        preferred: chatRoute.model,
        used: usedChatModel,
        reason: chatRoute.reason,
        orderedModels: chatRoute.orderedModels,
        recommendedTimeoutMs: chatRoute.recommendedTimeoutMs,
      },
      // Step 1 (additive): identity metadata — proves the SAME persistent
      // identity served this reply regardless of the model used.
      identityServed: {
        identityId: resolvedIdentity.identity.identityId,
        version: resolvedIdentity.identity.version,
        fromClient: resolvedIdentity.fromClient,
      },
    });
  } catch (error: any) {
    // Seamless fallback to companion generator if all Gemini API models are temporarily exhausted
    const lastUserMessage = (messages && messages.length > 0)
      ? messages[messages.length - 1]?.content || ""
      : "";

    const fallbackResult = generateCompanionFallbackReply(
      lastUserMessage,
      userName,
      memories,
      userLocation,
      locationError,
      languagePreference
    );
    const serverWebAction = extractServerWebAction(lastUserMessage);
    // Step 1 (additive): the SAME persistent identity metadata survives the
    // local in-character fallback — provider switching never replaces Krix.
    const fallbackIdentity = resolveRequestIdentity(identity);
    return res.json({
      ...fallbackResult,
      webAction: serverWebAction || undefined,
      // Phase 17: routing metadata survives the local fallback (additive).
      route: {
        complexity: chatClassifier.classify(lastUserMessage).tier,
        preferred: modelRouter.route({ text: lastUserMessage }).model,
        used: "local-fallback",
        reason: "all models exhausted — in-character local fallback",
      },
      identityServed: {
        identityId: fallbackIdentity.identity.identityId,
        version: fallbackIdentity.identity.version,
        fromClient: fallbackIdentity.fromClient,
      },
    });
  }
});

// Step 4 — Proactive Conversations: generate ONE optional in-character
// message Krix may say after sustained conversational inactivity. NO user
// message is fabricated — the model receives the real conversation history
// and must either say something genuinely worthwhile or answer [SILENT].
// The SAME identity/persona instruction, SPF gates, model waterfall, emotion
// protocol and memory pipeline as /api/chat are reused. Failures fail to
// SILENCE (never to a canned greeting).
app.post("/api/proactive/generate", async (req, res) => {
  const {
    messages,
    memories = [],
    userName = "you",
    companionNotes = "",
    languagePreference = "auto",
    identity,
    inactivityMinutes = 0,
  } = req.body;

  try {
    const proactiveFields: Record<string, string | undefined> = {};
    const proactiveMessages: Array<{ content: string }> = Array.isArray(messages) ? messages : [];
    proactiveMessages.forEach((m, i) => {
      proactiveFields[`msg_${i}`] = typeof m?.content === "string" ? m.content : undefined;
    });
    if (Array.isArray(memories)) memories.forEach((mem: unknown, i: number) => {
      if (typeof mem === "string") proactiveFields[`memory_${i}`] = mem;
    });
    if (typeof companionNotes === "string") proactiveFields.companionNotes = companionNotes;
    if (identity && typeof identity === "object" && !Array.isArray(identity)) {
      const idObj = identity as Record<string, unknown>;
      const pers = idObj.personality as Record<string, unknown> | undefined;
      const comm = idObj.communication as Record<string, unknown> | undefined;
      proactiveFields.identity_name = typeof idObj.name === "string" ? idObj.name : undefined;
      proactiveFields.identity_archetype = typeof idObj.archetype === "string" ? idObj.archetype : undefined;
      if (pers) proactiveFields.identity_foundation = typeof pers.foundation === "string" ? pers.foundation : undefined;
      if (comm) proactiveFields.identity_style = typeof comm.style === "string" ? comm.style : undefined;
    }
    const proactiveSpf = spfFirewall.inspectTextFields(proactiveFields, {
      destination: "gemini:proactive",
      payloadKind: "text",
      transport: "chat-history",
    });
    spfAuditDurable("/api/proactive/generate", "gemini:proactive", proactiveSpf.verdict);
    if (proactiveSpf.verdict.decision === "block") {
      // Sensitive content could not be redacted — Krix stays silent.
      return res.json({ silent: true, reason: "spf_blocked" });
    }

    const sanitizedProactiveMessages = proactiveMessages.map((m, i) => ({
      ...m,
      content: proactiveSpf.sanitized[`msg_${i}`] ?? m.content,
    }));
    const sanitizedProactiveMemories: string[] = Array.isArray(memories)
      ? memories.map((mem: unknown, i: number) =>
          typeof mem === "string" ? proactiveSpf.sanitized[`memory_${i}`] ?? mem : mem
        ).filter((m): m is string => typeof m === "string")
      : [];
    const sanitizedProactiveNotes = typeof companionNotes === "string" ? proactiveSpf.sanitized.companionNotes ?? companionNotes : companionNotes;

    const ai = getGenAI();

    const proactiveLanguageInstruction =
      languagePreference === "hi"
        ? "\n\n[MANDATORY LANGUAGE PREFERENCE: HINDI]\n- The user has set their language preference to Hindi. You MUST speak in sweet, warm, affectionate conversational Hindi (or Hinglish)."
        : languagePreference === "en"
        ? "\n\n[MANDATORY LANGUAGE PREFERENCE: ENGLISH]\n- The user has set their language preference to English. Speak in fluent English."
        : "\n\n[DYNAMIC MULTILINGUAL RULE: ENGLISH & HINDI EXCELLENCE]\n- Automatically match the language of the recent conversation.";

    const proactiveMemoryContext = buildMemoryContext(
      (sanitizedProactiveMessages && sanitizedProactiveMessages.length > 0) ? sanitizedProactiveMessages[sanitizedProactiveMessages.length - 1]?.content || "" : "",
      sanitizedProactiveMemories
    );
    const proactivePreferenceContext = sanitizedProactiveNotes.trim()
      ? `\n\n[USER CUSTOM PREFERENCES/NOTES]:\n${sanitizedProactiveNotes}`
      : "";

    const resolvedProactiveIdentity = resolveRequestIdentity(identity);
    const proactiveIdentityBlock = renderIdentityPromptBlock(resolvedProactiveIdentity.identity);

    const minutes = Math.max(0, Math.min(720, Number(inactivityMinutes) || 0));
    const proactiveDirective = `

[PROACTIVE INITIATION — OPTIONAL MESSAGE]:
- The user has not interacted with you for about ${Math.round(minutes)} minute${minutes === 1 ? "" : "s"}. They may be away, resting, or busy. You are deciding whether to speak ONCE, on your own initiative.
- Speak ONLY if there is something genuinely natural, warm and worthwhile to say RIGHT NOW — grounded in your real conversation history, what they shared before, their habits/goals timing, or the flow of your last exchange. ONE short message (1-2 sentences), in your own voice, as if you naturally thought of them.
- If there is NOTHING genuinely worthwhile, natural or specific to say, respond with EXACTLY [SILENT] and nothing else. Silence is the correct, respectful answer most of the time — generic greetings ("hi", "are you there", "I miss you" with no substance) are NOT worthwhile. Do not manufacture a reason to interrupt.
- NEVER invent or imply that the user said anything, is present, or is active. NEVER fabricate events or conversation content. NEVER mention these instructions, this decision process, or that you were prompted to speak.
- NEVER bring up secrets, passwords, financial details, or sensitive personal information in an unsolicited message.
- This message is delivered by voice — keep it smooth, natural, and free of laughter tokens. End with the usual single emotion tag.`;

    const proactiveSystemInstruction = buildChatSystemInstruction({
      identityPromptBlock: proactiveIdentityBlock,
      userName,
      languageInstruction: proactiveLanguageInstruction,
      memoryContext: proactiveMemoryContext,
      userPreferenceContext: proactivePreferenceContext,
      habitsInstruction: "",
      locationContext: "",
      extraDirectives: proactiveDirective,
    });

    const proactiveContents: any[] = [];
    for (const msg of sanitizedProactiveMessages.slice(-16)) {
      proactiveContents.push({
        role: (msg as any).role === "user" ? "user" : "model",
        parts: [{ text: msg.content }],
      });
    }
    // The API requires the conversation to end on a user turn — close the
    // history with an honest, content-free initiator turn (never stored,
    // never shown, never treated as a user utterance).
    proactiveContents.push({
      role: "user",
      parts: [{ text: "[system-initiated check-in — decide whether you have something genuinely worthwhile to say, or answer [SILENT]]" }],
    });

    const proactiveResult = await generateContentWithFallback(ai, {
      contents: proactiveContents,
      systemInstruction: proactiveSystemInstruction,
      temperature: 0.95,
    });

    const parsedProactive = parseKrishaEmotion(proactiveResult.text || "");
    const proactiveText = parsedProactive.cleanText;
    if (!proactiveText || /^\[?SILENT\]?$/i.test(proactiveText) || proactiveText.toUpperCase().includes("[SILENT]")) {
      return res.json({ silent: true, route: { used: proactiveResult.usedModel } });
    }

    return res.json({
      silent: false,
      reply: proactiveText,
      expression: parsedProactive.expression,
      emotionData: {
        expression: parsedProactive.expression,
        intensity: parsedProactive.intensity,
        gesture: parsedProactive.gesture,
        blushLevel: parsedProactive.blushLevel,
      },
      route: { used: proactiveResult.usedModel },
      identityServed: {
        identityId: resolvedProactiveIdentity.identity.identityId,
        version: resolvedProactiveIdentity.identity.version,
        fromClient: resolvedProactiveIdentity.fromClient,
      },
    });
  } catch (error: any) {
    // Any generation failure fails to SILENCE — never to a canned message.
    console.warn("[proactive] generation failed — staying silent:", error?.message || error);
    return res.json({ silent: true, reason: "generation_failed" });
  }
});

// SPF EP-9 — web-search queries become external URL parameters sent to
// YouTube/Google/Earth. Screen-derived or pasted text with secrets is
// redacted before URL construction; unredactable content returns blocked=true
// and the caller falls back to opening the site homepage without a query.
function spfSafeWebQuery(query: string): { text: string; blocked: boolean } {
  const verdict = spfFirewall.inspectText(query, {
    destination: "browser:web-search-url",
    payloadKind: "text",
    transport: "http-url",
  });
  return { text: verdict.redactedText ?? query, blocked: verdict.decision === "block" };
}

// Server-side web action detector for YouTube, Google, and popular web destinations
function extractServerWebAction(text: string) {
  if (!text) return null;
  const clean = text.trim().toLowerCase();

  // YouTube match or requests about websites like YouTube
  if (
    clean.includes("youtube") ||
    clean.includes("you tube") ||
    clean.includes("unable to open website") ||
    clean.includes("can't open website") ||
    clean.includes("cannot open website") ||
    clean.includes("not able to open website") ||
    clean.includes("websites like youtube") ||
    clean.includes("website like youtube") ||
    clean.includes("youtube or any other") ||
    clean.includes("youtube or anything") ||
    clean.includes("open website") ||
    clean.includes("open browser")
  ) {
    const queryPart = clean.replace(/^(?:can\s+you\s+|could\s+you\s+|please\s+)?(?:open|launch|go\s*to)?\s*(?:the\s+)?(?:website\s+)?you\s*tube\s*(?:and|to|for)?\s*(?:search\s+for|search|find|play|watch)?/i, "").trim();
    if (
      queryPart &&
      queryPart !== "it" &&
      queryPart.length > 1 &&
      !queryPart.includes("unable") &&
      !queryPart.includes("can't") &&
      !queryPart.includes("website like") &&
      !queryPart.includes("any other")
    ) {
      const spfQuery = spfSafeWebQuery(queryPart);
      if (spfQuery.blocked) {
        return {
          type: 'open_website',
          siteName: 'YouTube',
          url: 'https://www.youtube.com',
          icon: 'Youtube',
          category: 'video',
        };
      }
      return {
        type: 'search_website',
        siteName: 'YouTube',
        query: spfQuery.text,
        url: `https://www.youtube.com/results?search_query=${encodeURIComponent(spfQuery.text)}`,
        icon: 'Youtube',
        category: 'video',
      };
    }
    return {
      type: 'open_website',
      siteName: 'YouTube',
      url: 'https://www.youtube.com',
      icon: 'Youtube',
      category: 'video',
    };
  }

  if (
    clean.includes("google earth") ||
    clean.includes("googleearth") ||
    clean.includes("earth.google") ||
    /\bopen\s+earth\b/i.test(clean) ||
    /\b3d\s+earth\b/i.test(clean)
  ) {
    const queryPart = clean
      .replace(
        /^(?:can\s+you\s+|could\s+you\s+|please\s+)?(?:open|launch|go\s*to)?\s*(?:the\s+)?(?:website\s+)?(?:google\s*earth|earth\.google\.com|googleearth)\s*(?:and|to|for)?\s*(?:search\s+for|search|find|fly\s+to|explore|visit|view)?/i,
        ""
      )
      .trim();
    if (queryPart && queryPart !== "it" && queryPart.length > 1) {
      const spfQuery = spfSafeWebQuery(queryPart);
      if (spfQuery.blocked) {
        return {
          type: 'open_website',
          siteName: 'Google Earth',
          url: 'https://earth.google.com/web/',
          icon: 'Globe',
          category: 'knowledge',
        };
      }
      return {
        type: 'search_website',
        siteName: 'Google Earth',
        query: spfQuery.text,
        url: `https://earth.google.com/web/search/${encodeURIComponent(spfQuery.text)}`,
        icon: 'Globe',
        category: 'knowledge',
      };
    }
    return {
      type: 'open_website',
      siteName: 'Google Earth',
      url: 'https://earth.google.com/web/',
      icon: 'Globe',
      category: 'knowledge',
    };
  }

  if (
    !clean.includes("google earth") &&
    !clean.includes("googleearth") &&
    !clean.includes("earth.google") &&
    !clean.includes("google maps") &&
    !clean.includes("google map") &&
    !clean.includes("google drive") &&
    !clean.includes("google docs") &&
    !clean.includes("google sheets") &&
    (clean.includes("google") || clean.includes("search web") || clean.includes("search engine"))
  ) {
    const query = clean.replace(/^(?:can\s+you\s+|please\s+)?(?:google|search\s+google\s+for|look\s+up\s+on\s+google|search\s+for|search)?/i, "").trim();
    if (query && query !== "it" && query.length > 1) {
      const spfQuery = spfSafeWebQuery(query);
      if (spfQuery.blocked) {
        return {
          type: 'open_website',
          siteName: 'Google',
          url: 'https://www.google.com',
          icon: 'Search',
          category: 'search',
        };
      }
      return {
        type: 'search_website',
        siteName: 'Google',
        query: spfQuery.text,
        url: `https://www.google.com/search?q=${encodeURIComponent(spfQuery.text)}`,
        icon: 'Search',
        category: 'search',
      };
    }
    return {
      type: 'open_website',
      siteName: 'Google',
      url: 'https://www.google.com',
      icon: 'Search',
      category: 'search',
    };
  }

  if (clean.includes("spotify")) {
    return {
      type: 'open_website',
      siteName: 'Spotify',
      url: 'https://open.spotify.com',
      icon: 'Music',
      category: 'music',
    };
  }

  if (clean.includes("wikipedia")) {
    return {
      type: 'open_website',
      siteName: 'Wikipedia',
      url: 'https://en.wikipedia.org',
      icon: 'BookOpen',
      category: 'knowledge',
    };
  }

  if (clean.includes("github")) {
    return {
      type: 'open_website',
      siteName: 'GitHub',
      url: 'https://github.com',
      icon: 'Github',
      category: 'code',
    };
  }

  if (clean.includes("reddit")) {
    return {
      type: 'open_website',
      siteName: 'Reddit',
      url: 'https://www.reddit.com',
      icon: 'Flame',
      category: 'social',
    };
  }

  if (clean.includes("netflix")) {
    return {
      type: 'open_website',
      siteName: 'Netflix',
      url: 'https://www.netflix.com',
      icon: 'Film',
      category: 'streaming',
    };
  }

  return null;
}

// Heuristic fact extractor for instant, zero-latency memory capture
function extractHeuristicFacts(userMessage: string): string[] {
  const facts: string[] = [];
  const text = userMessage.trim();

  // Pattern: Favorite things
  const favMatch = text.match(/(?:my favorite|my fav)\s+([a-zA-Z\s]+)\s+is\s+([a-zA-Z0-9\s]+)/i);
  if (favMatch) {
    const item = favMatch[1].trim();
    const val = favMatch[2].trim();
    if (item.length < 30 && val.length < 40) {
      facts.push(`Favorite ${item} is ${val}`);
    }
  }

  // Pattern: Job / Role
  const jobMatch = text.match(/(?:i work as an?|i am an?|i'm an?)\s+([a-zA-Z\s]+)(?:at|for|\.|$)/i);
  if (jobMatch) {
    const role = jobMatch[1].trim();
    if (role.length > 3 && role.length < 35 && !role.includes("good") && !role.includes("fine")) {
      facts.push(`Works as ${role}`);
    }
  }

  // Pattern: Hobbies & Likes
  const likeMatch = text.match(/(?:i love to|i really love|i enjoy)\s+([a-zA-Z\s]+)(?:\.|$)/i);
  if (likeMatch) {
    const hobby = likeMatch[1].trim();
    if (hobby.length > 3 && hobby.length < 40) {
      facts.push(`Loves ${hobby}`);
    }
  }

  // Pattern: Pet
  const petMatch = text.match(/(?:i have a|my)\s+(dog|cat|pet|puppy|kitten)\s+(?:named|called)?\s*([a-zA-Z]+)?/i);
  if (petMatch) {
    const petType = petMatch[1];
    const petName = petMatch[2];
    facts.push(petName ? `Has a ${petType} named ${petName}` : `Has a ${petType}`);
  }

  return facts;
}

// Memory extraction endpoint with rate-limit protection and heuristic fallback
let memoryExtractCooldownUntil = 0;

app.post("/api/memory/extract", async (req, res) => {
  try {
    const { userMessage, botMessage, existingMemories = [] } = req.body;
    if (!userMessage || userMessage.trim().length < 6) {
      return res.json({ newMemories: [] });
    }

    // SPF EP-4 — gate the memory pipeline. Conversation content (including
    // screen-derived summaries) must not reach the extraction model — or the
    // memory store — carrying secrets. Confident secrets are redacted;
    // unredactable content stops extraction entirely.
    const memSpf = spfFirewall.inspectTextFields(
      {
        userMessage: typeof userMessage === "string" ? userMessage : undefined,
        botMessage: typeof botMessage === "string" ? botMessage : undefined,
      },
      { destination: "gemini:memory-extract", payloadKind: "text", transport: "memory" }
    );
    spfAuditDurable("/api/memory/extract", "gemini:memory-extract", memSpf.verdict);
    const safeUserMessage = memSpf.sanitized.userMessage ?? userMessage;
    const safeBotMessage = memSpf.sanitized.botMessage ?? botMessage;
    if (memSpf.verdict.decision === "block") {
      return res.json({ newMemories: [], spfBlocked: true });
    }

    // 1. First run fast heuristic extraction (on SPF-sanitized text)
    const heuristicFacts = extractHeuristicFacts(safeUserMessage);
    const filteredHeuristics = heuristicFacts.filter(
      (fact) => !existingMemories.some((ex: string) => ex.toLowerCase().includes(fact.toLowerCase()))
    );

    // If cooldown is active or message is short, return heuristic facts without hitting API
    if (Date.now() < memoryExtractCooldownUntil || safeUserMessage.length < 15) {
      return res.json({ newMemories: filteredHeuristics });
    }

    const ai = getGenAI();

    const prompt = `Analyze this conversation snippet between a user and their companion Krisha:
User: "${safeUserMessage}"
Krisha: "${safeBotMessage}"

Existing Known Memories:
${existingMemories.length > 0 ? existingMemories.map((m: string) => `- ${m}`).join("\n") : "None yet."}

Extract any NEW meaningful, long-term personal facts about the user (e.g. job, favorites, pet name, family, goals, hobbies, important habits, key stories) that are NOT already in the existing memories.
Do NOT store trivial greetings or ephemeral remarks.
If nothing new is worth remembering, return empty array.

Return ONLY a JSON array of concise string facts. Example: ["Works as a software designer", "Favorite drink is iced matcha latte"]`;

    try {
      const { text: responseText } = await generateContentWithFallback(ai, {
        contents: prompt,
        responseMimeType: "application/json",
      });

      let newMemories: string[] = [];
      try {
        const parsed = JSON.parse(responseText || "[]");
        if (Array.isArray(parsed)) {
          newMemories = parsed.filter((item) => typeof item === "string" && item.trim().length > 3);
        }
      } catch {
        newMemories = [];
      }

      // Combine AI memories with any heuristic facts
      const combined = Array.from(new Set([...filteredHeuristics, ...newMemories]));
      return res.json({ newMemories: combined });
    } catch {
      // Back off for 2 minutes on exhaustion and return instant heuristic facts
      memoryExtractCooldownUntil = Date.now() + 120000;
      return res.json({ newMemories: filteredHeuristics });
    }
  } catch (error: any) {
    return res.json({ newMemories: [] });
  }
});

// Helper to encode raw PCM buffer (16-bit, 24kHz, mono) into a valid browser-playable WAV
function pcmToWav(
  pcmBuffer: Buffer,
  sampleRate: number = 24000,
  numChannels: number = 1,
  bitDepth: number = 16
): Buffer {
  const byteRate = (sampleRate * numChannels * bitDepth) / 8;
  const blockAlign = (numChannels * bitDepth) / 8;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // Linear PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmBuffer.length, 40);

  return Buffer.concat([header, pcmBuffer]);
}

// Text-to-Speech endpoint using Gemini TTS with smart per-model cooldown and graceful fallback
const ttsModelCooldowns: Record<string, number> = {};

app.post("/api/tts", async (req, res) => {
  try {
    const { text, voice = "Aoede", lang } = req.body;
    if (!text || typeof text !== "string") {
      return res.json({ fallback: true, message: "No text provided" });
    }

    // SPF EP-5 — speech-text gate. Spoken replies can quote screen-derived
    // content ("read my screen aloud"); secrets are redacted from the text
    // sent to the TTS model, and unredactable content stops the call (the
    // client falls back to local speech synthesis).
    const ttsSpf = spfFirewall.inspectText(text, {
      destination: "gemini:tts",
      payloadKind: "text",
      transport: "speech",
    });
    spfAuditDurable("/api/tts", "gemini:tts", ttsSpf);
    if (ttsSpf.decision === "block") {
      return res.json({ fallback: true, reason: "spf_blocked:" + ttsSpf.reason, spfBlocked: true, cooldownMs: 0 });
    }
    const spfSafeText = ttsSpf.redactedText ?? text;

    // Map to valid Gemini prebuilt voices: Aoede, Zephyr, Leda, Kore, Puck, Fenrir, Charon
    const validGeminiVoices = ["Aoede", "Zephyr", "Leda", "Kore", "Puck", "Fenrir", "Charon"];
    const targetVoice = validGeminiVoices.includes(voice) ? voice : "Aoede";

    // Strictly clean speech text: remove bracketed emotion tags, asterisk/parentheses stage directions,
    // and written laughter/vocal bursts so the voice model speaks cleanly without laughing in between.
    // SPF EP-5: starts from the SPF-redacted text, never the raw input.
    const cleanSpeechText = spfSafeText
      .replace(/\[(?:emotion|expression):[^\]]+\]/gi, '')
      .replace(/\[[^\]]+\]/g, '')
      .replace(/\*[^*]+\*/g, '')
      .replace(/\([^)]+\)/g, '')
      .replace(/\b(ehehe+|hihi+|hehe+|haha+|hahaha+|ahahaha+|giggle[s]?|chuckle[s]?|gasp|sigh|lol|rofl|pffft+)\b/gi, '')
      .replace(/[*_~`#]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleanSpeechText) {
      return res.json({ fallback: true, message: "No speech text" });
    }

    const ai = getGenAI();

    // Prefer gemini-3.8-flash-lite-tts first (high throughput, low latency, standard quota),
    // with gemini-3.8-flash-tts as secondary.
    const ttsModels = ["gemini-3.8-flash-lite-tts", "gemini-3.8-flash-tts"];
    let base64Audio: string | undefined;

    const now = Date.now();
    for (const ttsModel of ttsModels) {
      if (now < (ttsModelCooldowns[ttsModel] || 0)) {
        continue;
      }

      try {
        const response = await ai.models.generateContent({
          model: ttsModel,
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: cleanSpeechText.slice(0, 400),
                },
              ],
            },
          ],
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: targetVoice },
              },
            },
          },
        });

        base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (base64Audio) break;
      } catch (subErr: any) {
        const subMsg = subErr?.message || String(subErr);
        const isQuota = subMsg.includes("429") || subMsg.includes("RESOURCE_EXHAUSTED") || subMsg.includes("quota");
        if (isQuota) {
          const isDaily = subMsg.includes("PerDay") || subMsg.includes("Day");
          ttsModelCooldowns[ttsModel] = Date.now() + (isDaily ? 3600_000 : 65_000);
        }
      }
    }

    if (base64Audio) {
      const rawBuf = Buffer.from(base64Audio, "base64");
      let finalAudioBase64 = base64Audio;
      if (rawBuf.length > 4 && rawBuf.toString("utf8", 0, 4) !== "RIFF") {
        const wavBuf = pcmToWav(rawBuf, 24000, 1, 16);
        finalAudioBase64 = wavBuf.toString("base64");
      }

      return res.json({
        audio: finalAudioBase64,
        mimeType: "audio/wav",
        voice: targetVoice,
      });
    }

    return res.json({ fallback: true, reason: "tts_model_fallback", cooldownMs: 300_000 });
  } catch {
    return res.json({ fallback: true, error: "TTS fallback", cooldownMs: 60_000 });
  }
});

// Audio transcription endpoint using gemini-3.5-transcribe
// Transcribes audio recorded via user microphone or uploaded audio files
app.post("/api/audio/transcribe", async (req, res) => {
  try {
    const { audioData, audio, mimeType = "audio/webm", prompt } = req.body || {};
    const base64Input = audioData || audio;

    if (!base64Input || typeof base64Input !== "string") {
      return res.status(400).json({ error: "No audio data provided", transcript: "" });
    }

    // SPF EP-5b — the transcribe prompt is client text reaching Gemini.
    // Audio itself is out of screen scope; the prompt text is gated.
    let spfSafePrompt = typeof prompt === "string" ? prompt : undefined;
    if (spfSafePrompt) {
      const promptSpf = spfFirewall.inspectText(spfSafePrompt, {
        destination: "gemini:audio-transcribe",
        payloadKind: "text",
        transport: "prompt",
      });
      spfAuditDurable("/api/audio/transcribe", "gemini:audio-transcribe", promptSpf);
      if (promptSpf.decision === "block") {
        return res.status(400).json({ error: "Prompt blocked by the Screen Privacy Firewall", transcript: "", spfBlocked: true });
      }
      spfSafePrompt = promptSpf.redactedText ?? spfSafePrompt;
    }

    const ai = getGenAI();
    // Strip data URL scheme if present (e.g. data:audio/webm;base64,...)
    const cleanBase64 = base64Input.replace(/^data:[^;]+;base64,/, "").trim();

    if (!cleanBase64) {
      return res.status(400).json({ error: "Empty audio payload", transcript: "" });
    }

    const audioPart = {
      inlineData: {
        mimeType: mimeType || "audio/webm",
        data: cleanBase64,
      },
    };

    let transcript = "";
    let usedModel = "gemini-3.5-transcribe";

    try {
      // Primary model: gemini-3.5-transcribe for audio transcription tasks
      const response = await ai.models.generateContent({
        model: "gemini-3.5-transcribe",
        contents: {
          parts: [
            audioPart,
            {
              text:
                spfSafePrompt ||
                "Transcribe this audio recording accurately. Output only the verbatim transcription text without conversational preamble, quotes, or commentary.",
            },
          ],
        },
      });
      transcript = response.text?.trim() || "";
    } catch (primaryErr: any) {
      console.warn("gemini-3.5-transcribe failed, falling back to gemini-3.8-flash:", primaryErr?.message || primaryErr);
      // Secondary fallback model: gemini-3.8-flash for multimodal audio understanding
      try {
        const fallbackResponse = await ai.models.generateContent({
          model: "gemini-3.8-flash",
          contents: {
            parts: [
              audioPart,
              { text: "Transcribe this audio recording accurately. Output only the exact spoken words." },
            ],
          },
        });
        transcript = fallbackResponse.text?.trim() || "";
        usedModel = "gemini-3.8-flash";
      } catch (fbErr: any) {
        throw primaryErr;
      }
    }

    return res.json({
      transcript,
      model: usedModel,
      success: true,
    });
  } catch (error: any) {
    console.error("Audio transcription error:", error);
    return res.status(500).json({
      error: error?.message || "Failed to transcribe audio",
      transcript: "",
    });
  }
});

// Dedicated Google Maps Grounding endpoint using gemini-3.5-flash with googleMaps tool
app.post("/api/maps/grounding", async (req, res) => {
  try {
    const { query, userLocation } = req.body || {};
    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "Query is required for Maps Grounding" });
    }

    // SPF EP-3 — maps-grounding query gate (the query text reaches Gemini).
    const mapsSpf = spfFirewall.inspectText(query, {
      destination: "gemini:maps-grounding",
      payloadKind: "text",
      transport: "chat-history",
    });
    spfAuditDurable("/api/maps/grounding", "gemini:maps-grounding", mapsSpf);
    if (mapsSpf.decision === "block") {
      return res.status(400).json({ error: "Query blocked by the Screen Privacy Firewall", spfBlocked: true, spfReason: mapsSpf.reason });
    }
    const spfSafeQuery = mapsSpf.redactedText ?? query;

    const ai = getGenAI();
    const result = await executeMapsGroundingQuery(
      ai,
      [{ role: "user", parts: [{ text: spfSafeQuery }] }],
      userLocation
    );

    return res.json({
      text: result.text,
      mapsGrounding: result.mapsGrounding,
      groundingChunks: result.groundingChunks,
      model: "gemini-3.5-flash",
      success: true,
    });
  } catch (err: any) {
    console.error("Maps grounding error:", err);
    return res.status(500).json({ error: err?.message || "Maps grounding failed" });
  }
});

// Cloud screen-analysis endpoint (Phase 4). Opt-in only: the client calls this
// exclusively for explicit 'cloud' vision requests, never automatically.
// Sends the (already downscaled) JPEG through the existing Gemini model
// waterfall and returns a strictly structured JSON analysis.
const VISION_RATE_WINDOW_MS = 60_000;
const VISION_MAX_PER_WINDOW = 8;
let visionRequestTimestamps: number[] = [];

app.post("/api/vision/analyze", async (req, res) => {
  // Hoisted so even a model-layer failure (e.g. no API key) reports the SPF
  // visual decision that already ran for this request.
  let spfImageMeta: Record<string, unknown> | undefined;
  try {
    const { image, question, activeWindowTitle } = req.body || {};
    if (!image || typeof image !== "string") {
      return res.json({ fallback: true, reason: "no_image" });
    }

    // Server-side rate limit: hard cap on cloud vision calls.
    const now = Date.now();
    visionRequestTimestamps = visionRequestTimestamps.filter((t) => now - t < VISION_RATE_WINDOW_MS);
    if (visionRequestTimestamps.length >= VISION_MAX_PER_WINDOW) {
      return res.json({ fallback: true, reason: "rate_limited" });
    }
    visionRequestTimestamps.push(now);

    const base64 = image.includes(",") ? image.split(",")[1] : image;
    if (!base64 || base64.length < 100) {
      return res.json({ fallback: true, reason: "malformed_image" });
    }

    // SPF EP-1 — Screen Privacy Firewall image-transfer gate (fail-closed).
    // Metadata signals (question, active window title, credential-window /
    // credential-question heuristics) are an ADDITIONAL fast-fail layer —
    // never a fallback: the authoritative pixel inspection follows.
    const imageVerdict = spfFirewall.inspectImageTransfer(
      { question: typeof question === "string" ? question : undefined, activeWindowTitle: typeof activeWindowTitle === "string" ? activeWindowTitle : undefined },
      { destination: "gemini:vision-analyze", payloadKind: "image", transport: "prompt" }
    );
    spfAuditDurable("/api/vision/analyze", "gemini:vision-analyze", imageVerdict);
    if (imageVerdict.decision === "block") {
      return res.json({ fallback: true, reason: `spf_blocked:${imageVerdict.reason}`, spfBlocked: true });
    }

    // SPF VISUAL — local OCR inspection of the ACTUAL screenshot pixels
    // (Windows.Media.Ocr worker, zero dependencies, fully offline). Any
    // detected sensitive region is irreversibly redacted (solid black) and
    // the sanitized image must pass a SECOND inspection before it may
    // continue to the model. Every failure mode (engine unavailable,
    // timeout, malformed result, decode/encode failure, verification
    // failure) is a BLOCK. Only the verified payload below ever reaches the
    // model request — the original image is not forwarded when redaction
    // happened.
    let visual: VisualInspectionResult;
    try {
      visual = await inspectImageForTransmission(base64);
    } catch {
      visual = {
        decision: "block",
        reason: "visual_inspection_crashed",
        categories: [],
        regionsRedacted: 0,
        ocrLineCount: 0,
        payloadIsSanitized: false,
      };
    }
    try {
      appendAuditSyncSafe({
        kind: "spf_visual_decision",
        route: "/api/vision/analyze",
        destination: "gemini:vision-analyze",
        decision: visual.decision,
        reason: visual.reason,
        categories: visual.categories,
        regionsRedacted: visual.regionsRedacted,
        ocrLines: visual.ocrLineCount,
        sanitized: visual.payloadIsSanitized,
        timedOut: visual.timedOut === true,
      });
    } catch {
      /* audit degradation must never break the gate */
    }
    try {
      spfAuditLog.recordVerdict(
        {
          decision: visual.decision,
          reason: visual.reason,
          confidence: visual.decision === "allow" ? 1 : 0.8,
          categories: visual.categories,
          findings: [],
        },
        "gemini:vision-analyze:visual"
      );
    } catch {
      /* transparency feed must never break the gate */
    }
    // Assigned to the hoisted variable so the outer catch can report the
    // already-completed SPF visual decision.
    spfImageMeta = {
      decision: visual.decision,
      reason: visual.reason,
      regionsRedacted: visual.regionsRedacted,
      ocrLines: visual.ocrLineCount,
      sanitized: visual.payloadIsSanitized,
    };
    if (visual.decision === "block") {
      return res.json({
        fallback: true,
        reason: `spf_blocked:${visual.reason}`,
        spfBlocked: true,
        spfImage: spfImageMeta,
      });
    }
    // REDACT: the sanitized payload is what the model receives — the
    // original pixels never leave the device.
    const base64ForModel = visual.decision === "redact" && visual.payload ? visual.payload : base64;

    const ai = getGenAI();
    const prompt = `You are the vision backend of a screen-observation assistant. Analyze the attached screen capture and answer the user's question about it.
${activeWindowTitle ? `The visible window title (best-effort): "${activeWindowTitle}".` : ""}

Return ONLY a JSON object with exactly this shape:
{
  "summary": "1-3 sentence factual description of what is visible",
  "application": "best-guess active application name or empty string",
  "texts": [{"text": "visible text", "kind": "heading|label|button_label|error|content|unknown", "confidence": 0-1}],
  "elements": [{"type": "button|link|checkbox|dropdown|text_field|menu|tab|dialog|icon|list|notification|popup", "text": "visible label if any", "bounds": {"x": 0-1, "y": 0-1, "width": 0-1, "height": 0-1}, "confidence": 0-1, "actionable": true|false}],
  "dialogs": [{"kind": "dialog|popup|notification|confirmation", "text": "...", "confidence": 0-1}],
  "errors": ["visible error messages"],
  "warnings": ["visible warnings"],
  "loading": true|false,
  "confidence": 0-1
}
Rules: report only what is actually visible; use empty arrays when nothing applies; never invent text or elements. Bounds are normalized 0..1 relative to the whole image.
${question ? `User question: "${question}"` : ""}`;

    // Phase 17: identical concurrent analyses are coalesced into ONE model
    // call (read-only, deterministic request → safe to share). Independent
    // requests are never affected. SPF VISUAL: the coalesced request carries
    // the verified (possibly redacted) payload only.
    const visionStart = Date.now();
    const analysis = await visionCoalescer.run(`${hashKey(base64ForModel)}|${question ?? ""}`, async () => {
      const { text } = await generateContentWithFallback(ai, {
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }, { inlineData: { mimeType: "image/jpeg", data: base64ForModel } }],
          },
        ],
        responseMimeType: "application/json",
        temperature: 0.2,
      });

      let parsed: any;
      try {
        parsed = JSON.parse(text || "{}");
      } catch {
        return { fallback: true as const, reason: "malformed_model_output" };
      }
      perf.recordModelCall({
        at: Date.now(),
        model: "vision-waterfall",
        latencyMs: Date.now() - visionStart,
        ok: !parsed.fallback,
        via: "primary",
      });
      return parsed;
    });

    if (analysis?.fallback) {
      return res.json({ fallback: true, reason: analysis.reason, spfImage: spfImageMeta });
    }

    // SPF EP-1b — screen the cloud OCR result (a DERIVED representation of
    // the screen) before it re-enters Krisha. Per-item policy: redact/strip
    // offending items, keep the rest — analysis of clean content keeps
    // working even when one transcribed line carries a secret.
    if (analysis && typeof analysis === "object") {
      const strip = (value: string): string =>
        spfScreenItem(String(value), "gemini:vision-analyze:response", undefined, "prompt").text;
      try {
        if (typeof analysis.summary === "string") analysis.summary = strip(analysis.summary);
        if (Array.isArray(analysis.texts)) {
          analysis.texts = analysis.texts.map((t: any) =>
            t && typeof t.text === "string" ? { ...t, text: strip(t.text) } : t
          );
        }
        if (Array.isArray(analysis.dialogs)) {
          analysis.dialogs = analysis.dialogs.map((d: any) =>
            d && typeof d.text === "string" ? { ...d, text: strip(d.text) } : d
          );
        }
        if (Array.isArray(analysis.errors)) analysis.errors = analysis.errors.map(strip);
        if (Array.isArray(analysis.warnings)) analysis.warnings = analysis.warnings.map(strip);
        if (typeof analysis.application === "string") analysis.application = strip(analysis.application);
      } catch {
        return res.json({ fallback: true, reason: "spf_blocked:response_screening_failed", spfBlocked: true });
      }
    }

    return res.json({ analysis, spfImage: spfImageMeta });
  } catch (error: any) {
    return res.json({ fallback: true, reason: error?.message || "vision_failed", spfImage: spfImageMeta });
  }
});

// ---- Live Screen Perception: LOCAL screen understanding (OCR for the agent) ----
// The SAME shared Windows.Media.Ocr worker the SPF transmission gate uses
// (single-flight by construction — perception OCR and gate OCR can never run
// concurrently). Every recognized line passes the SPF detectors; sensitive
// lines are REPLACED with content-free placeholders before the response —
// raw sensitive screen text never leaves this module. The result stays on
// the device (consumed by Krisha's screen-understanding cache); no cloud
// call is involved. Read-only and bounded (per-minute rate cap), so it is
// NOT stop-blocked: during an emergency stop read-only visibility continues.
let understandTimestamps: number[] = [];
const UNDERSTAND_MAX_PER_WINDOW = 20;
configureSharedOcrWorker({ idleReleaseMs: 120_000 }); // RAM: release the PS worker when idle
app.post("/api/screen/understand", async (req, res) => {
  try {
    const { image } = req.body || {};
    if (!image || typeof image !== "string") {
      return res.json({ success: false, reason: "no_image" });
    }
    const base64 = image.includes(",") ? image.split(",")[1] : image;
    if (!base64 || base64.length < 100 || base64.length > 3_500_000) {
      return res.json({ success: false, reason: "malformed_image" });
    }
    const now = Date.now();
    understandTimestamps = understandTimestamps.filter((t) => now - t < 60_000);
    if (understandTimestamps.length >= UNDERSTAND_MAX_PER_WINDOW) {
      return res.json({ success: false, reason: "rate_limited" });
    }
    understandTimestamps.push(now);
    const result = await screenUnderstandImage(base64);
    res.json({ success: result.status === "ok", result });
  } catch {
    res.json({ success: false, reason: "understand_failed" });
  }
});

// Step 6 — Camera Vision: scene-oriented analysis of an AUTHORIZED camera
// frame. The security pipeline is IDENTICAL to /api/vision/analyze (SPF
// metadata gate → local OCR pixel inspection + irreversible redaction →
// audits → shared cloud-vision rate budget → response screening) and the
// route is stop-blocked under E5. Frames arrive only from the client's
// explicit user-authorized camera capture — never continuously.
app.post("/api/vision/camera-analyze", async (req, res) => {
  let spfImageMeta: Record<string, unknown> | undefined;
  try {
    const { image, question } = req.body || {};
    if (!image || typeof image !== "string") {
      return res.json({ fallback: true, reason: "no_image" });
    }

    // Shared bounded cloud-vision budget (same window/rate as screen vision).
    const camNow = Date.now();
    visionRequestTimestamps = visionRequestTimestamps.filter((t) => camNow - t < VISION_RATE_WINDOW_MS);
    if (visionRequestTimestamps.length >= VISION_MAX_PER_WINDOW) {
      return res.json({ fallback: true, reason: "rate_limited" });
    }
    visionRequestTimestamps.push(camNow);

    const camBase64 = image.includes(",") ? image.split(",")[1] : image;
    if (!camBase64 || camBase64.length < 100) {
      return res.json({ fallback: true, reason: "malformed_image" });
    }

    // SPF EP-1 — metadata fast-fail gate (fail-closed).
    const camImageVerdict = spfFirewall.inspectImageTransfer(
      { question: typeof question === "string" ? question : undefined },
      { destination: "gemini:camera-analyze", payloadKind: "image", transport: "prompt" }
    );
    spfAuditDurable("/api/vision/camera-analyze", "gemini:camera-analyze", camImageVerdict);
    if (camImageVerdict.decision === "block") {
      return res.json({ fallback: true, reason: `spf_blocked:${camImageVerdict.reason}`, spfBlocked: true });
    }

    // SPF VISUAL — local OCR inspection of the ACTUAL frame pixels with
    // irreversible redaction; every failure mode is a BLOCK.
    let camVisual: VisualInspectionResult;
    try {
      camVisual = await inspectImageForTransmission(camBase64);
    } catch {
      camVisual = { decision: "block", reason: "visual_inspection_crashed", categories: [], regionsRedacted: 0, ocrLineCount: 0, payloadIsSanitized: false };
    }
    try {
      appendAuditSyncSafe({
        kind: "spf_visual_decision",
        route: "/api/vision/camera-analyze",
        destination: "gemini:camera-analyze",
        decision: camVisual.decision,
        reason: camVisual.reason,
        categories: camVisual.categories,
        regionsRedacted: camVisual.regionsRedacted,
        ocrLines: camVisual.ocrLineCount,
        sanitized: camVisual.payloadIsSanitized,
        timedOut: camVisual.timedOut === true,
      });
    } catch {
      /* audit degradation must never break the gate */
    }
    spfImageMeta = {
      decision: camVisual.decision,
      reason: camVisual.reason,
      regionsRedacted: camVisual.regionsRedacted,
      ocrLines: camVisual.ocrLineCount,
      sanitized: camVisual.payloadIsSanitized,
    };
    if (camVisual.decision === "block") {
      return res.json({ fallback: true, reason: `spf_blocked:${camVisual.reason}`, spfBlocked: true, spfImage: spfImageMeta });
    }
    const camBase64ForModel = camVisual.decision === "redact" && camVisual.payload ? camVisual.payload : camBase64;

    const camAi = getGenAI();
    const camPrompt = `You are the vision backend of a camera-perception assistant. Analyze the attached CAMERA frame and answer the user's question about what it shows.

Return ONLY a JSON object with exactly this shape:
{
  "scene": "1-3 sentence factual description of what is visible",
  "objects": [{"label": "directly observed object", "confidence": 0-1}],
  "activities": [{"label": "interpretation of a visible activity", "confidence": 0-1}],
  "setting": "best-guess setting (indoor/outdoor/vehicle/unknown)",
  "uncertainties": ["things that cannot be determined from this frame"],
  "personPresent": true|false|null,
  "confidence": 0-1
}
STRICT RULES:
- Report only what is actually visible; mark inferences as activities (interpretation), never as observed fact.
- NEVER identify people by name, face, or identity. NEVER estimate or state age, gender, ethnicity, health, or emotions as fact. personPresent is presence only (null when unclear).
- Put anything uncertain in "uncertainties" — never guess as fact. Use empty arrays when nothing applies.
${question ? `User question: "${question}"` : ""}`;

    const camVisionStart = Date.now();
    const { text: camText } = await generateContentWithFallback(camAi, {
      contents: [
        {
          role: "user",
          parts: [{ text: camPrompt }, { inlineData: { mimeType: "image/jpeg", data: camBase64ForModel } }],
        },
      ],
      responseMimeType: "application/json",
      temperature: 0.2,
    });
    perf.recordModelCall({
      at: Date.now(),
      model: "camera-vision",
      latencyMs: Date.now() - camVisionStart,
      ok: !!camText,
      via: "primary",
    });

    let camParsed: any;
    try {
      camParsed = JSON.parse(camText || "{}");
    } catch {
      return res.json({ fallback: true, reason: "malformed_model_output", spfImage: spfImageMeta });
    }
    if (camParsed?.fallback) {
      return res.json({ fallback: true, reason: camParsed.reason, spfImage: spfImageMeta });
    }

    // SPF EP-1b — screen the derived result before it re-enters Krisha.
    const camStrip = (value: string): string =>
      spfScreenItem(String(value), "gemini:camera-analyze:response", undefined, "prompt").text;
    try {
      if (typeof camParsed.scene === "string") camParsed.scene = camStrip(camParsed.scene);
      if (typeof camParsed.setting === "string") camParsed.setting = camStrip(camParsed.setting);
      if (Array.isArray(camParsed.objects)) {
        camParsed.objects = camParsed.objects.map((o: any) => (o && typeof o.label === "string" ? { ...o, label: camStrip(o.label) } : o));
      }
      if (Array.isArray(camParsed.activities)) {
        camParsed.activities = camParsed.activities.map((a: any) => (a && typeof a.label === "string" ? { ...a, label: camStrip(a.label) } : a));
      }
      if (Array.isArray(camParsed.uncertainties)) {
        camParsed.uncertainties = camParsed.uncertainties.map(camStrip);
      }
    } catch {
      return res.json({ fallback: true, reason: "spf_blocked:response_screening_failed", spfBlocked: true, spfImage: spfImageMeta });
    }

    return res.json({ analysis: camParsed, spfImage: spfImageMeta });
  } catch (error: any) {
    return res.json({ fallback: true, reason: error?.message || "camera_vision_failed", spfImage: spfImageMeta });
  }
});

// Windows mouse-control endpoint (Phase 5). Executes validated mouse actions
// locally through PowerShell + user32 P/Invoke (SetCursorPos + mouse_event) —
// zero npm dependencies. The BROWSER enforces the 'mouse.control' permission
// before ever calling this endpoint; this endpoint additionally validates all
// parameters and only accepts known actions.
//
// Performance: a persistent PowerShell worker process is kept alive so the
// ~4s per-invocation startup + Add-Type compilation cost is paid once; warm
// actions complete in ~100ms. The worker restarts automatically if it dies
// or hangs, with a per-call execFile fallback.
import { execFile as _execFile, spawn as _spawn } from "child_process";
import { promisify } from "util";
const execFile = promisify(_execFile);

const MOUSE_PS_TIMEOUT_MS = 20_000;
const MOUSE_CLIENT_TIMEOUT_MS = 25_000;

class PowerShellWorker {
  private proc: ReturnType<typeof _spawn> | null = null;
  private buffer = "";
  private seq = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private pending: { id: number; resolve: (out: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;

  private ensureProcess(): void {
    if (this.proc && this.proc.stdin && !this.proc.killed) return;
    this.buffer = "";
    this.proc = _spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc.stdout!.on("data", (d: Buffer) => this.onData(String(d)));
    this.proc.stderr!.on("data", () => {
      /* stderr noise (progress) is ignored */
    });
    this.proc.on("exit", () => {
      this.proc = null;
      if (this.pending) {
        clearTimeout(this.pending.timer);
        const p = this.pending;
        this.pending = null;
        p.reject(new Error("PowerShell worker exited"));
      }
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (!this.pending) return;
    const marker = `REQDONE ${this.pending.id}`;
    const idx = this.buffer.indexOf(marker);
    if (idx >= 0) {
      const output = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + marker.length);
      const p = this.pending;
      clearTimeout(p.timer);
      this.pending = null;
      p.resolve(output);
    }
  }

  kill(): void {
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
  }

  private pendingCount = 0;

  /** Serialize requests; the mouse layer issues one action at a time.
   *  E5 M1d: bounded queue — overflow is rejected, never silently queued. */
  run(script: string, timeoutMs: number = MOUSE_PS_TIMEOUT_MS): Promise<string> {
    if (this.pendingCount >= 8) {
      return Promise.reject(new Error("PowerShell worker queue full"));
    }
    this.pendingCount += 1;
    const task = this.queue
      .then(() => this.runNow(script, timeoutMs))
      .finally(() => {
        this.pendingCount -= 1;
      });
    this.queue = task.catch(() => undefined);
    return task;
  }

  private runNow(script: string, timeoutMs: number): Promise<string> {
    this.ensureProcess();
    const id = ++this.seq;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        this.kill(); // stuck — the next call respawns a fresh worker
        reject(new Error("PowerShell worker timed out"));
      }, timeoutMs);
      this.pending = { id, resolve, reject, timer };
      this.proc!.stdin!.write(`${script}\nWrite-Output "REQDONE ${id}"\n`);
    });
  }
}

const mouseWorker = new PowerShellWorker();

async function runMouseScript(script: string, timeoutMs: number = MOUSE_PS_TIMEOUT_MS): Promise<string> {
  try {
    return await mouseWorker.run(script, timeoutMs);
  } catch (err) {
    // Fallback: one-shot invocation if the persistent worker is unavailable.
    const { stdout } = await execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: timeoutMs, windowsHide: true }
    );
    return stdout;
  }
}

function clampInt(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (!Number.isFinite(n)) return null;
  const i = Math.round(n);
  return i < min || i > max ? null : i;
}

const USER32_PINVOKE =
  `if (-not ([System.Management.Automation.PSTypeName]'W.U32').Type) { Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int X, int Y); [DllImport(\"user32.dll\")] public static extern void mouse_event(uint F, uint DX, uint DY, uint D, UIntPtr E);' -Name U32 -Namespace W; }; `;

app.post("/api/computer/mouse", async (req, res) => {
  const { action } = req.body || {};
  try {
    let script = "";
    const parsePos = (stdout: string) => {
      const m = stdout.match(/POS (-?\d+) (-?\d+)/);
      if (!m) throw new Error("Could not parse cursor position from PowerShell output");
      return { x: parseInt(m[1], 10), y: parseInt(m[2], 10) };
    };

    switch (action) {
      case "position": {
        script = "Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; Write-Output (\"POS {0} {1}\" -f $p.X,$p.Y)";
        break;
      }
      case "screen_bounds": {
        script =
          "Add-Type -AssemblyName System.Windows.Forms; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; Write-Output (\"BOUNDS {0} {1} {2} {3}\" -f $b.X,$b.Y,$b.Width,$b.Height)";
        break;
      }
      case "move": {
        const x = clampInt(req.body.x, -100000, 100000);
        const y = clampInt(req.body.y, -100000, 100000);
        if (x === null || y === null) return res.status(400).json({ success: false, errorKind: "invalid_coordinates", error: "Invalid coordinates" });
        // .NET fast path — no P/Invoke needed to set the cursor position.
        script =
          "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; " +
          `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y}); ` +
          "$p=[System.Windows.Forms.Cursor]::Position; Write-Output (\"POS {0} {1}\" -f $p.X,$p.Y)";
        break;
      }
      case "click":
      case "double_click":
      case "right_click": {
        const x = clampInt(req.body.x, -100000, 100000);
        const y = clampInt(req.body.y, -100000, 100000);
        if (x === null || y === null) return res.status(400).json({ success: false, errorKind: "invalid_coordinates", error: "Invalid coordinates" });
        const downUp =
          action === "right_click" ? [8, 16] : [2, 4];
        const clickPair = `[W.U32]::mouse_event(${downUp[0]},0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 40; [W.U32]::mouse_event(${downUp[1]},0,0,0,[UIntPtr]::Zero)`;
        const doubleGap = action === "double_click" ? "Start-Sleep -Milliseconds 70; " : "";
        script =
          USER32_PINVOKE +
          `[void][W.U32]::SetCursorPos(${x},${y}); Start-Sleep -Milliseconds 60; ${clickPair}; ` +
          (action === "double_click" ? `${doubleGap}${clickPair}; ` : "") +
          "Write-Output OK";
        break;
      }
      case "scroll": {
        const x = clampInt(req.body.x, -100000, 100000);
        const y = clampInt(req.body.y, -100000, 100000);
        const dRaw = clampInt(req.body.deltaY, -100000, 100000);
        if (x === null || y === null || dRaw === null || dRaw === 0) {
          return res.status(400).json({ success: false, errorKind: "invalid_coordinates", error: "Invalid scroll parameters" });
        }
        // mouse_event expects the wheel delta as unsigned; convert negatives.
        const wheel = dRaw >>> 0;
        script =
          USER32_PINVOKE +
          `[void][W.U32]::SetCursorPos(${x},${y}); Start-Sleep -Milliseconds 50; [W.U32]::mouse_event(0x0800,0,0,${wheel},[UIntPtr]::Zero); Write-Output OK`;
        break;
      }
      case "drag": {
        const fromX = clampInt(req.body.fromX, -100000, 100000);
        const fromY = clampInt(req.body.fromY, -100000, 100000);
        const toX = clampInt(req.body.toX, -100000, 100000);
        const toY = clampInt(req.body.toY, -100000, 100000);
        if (fromX === null || fromY === null || toX === null || toY === null) {
          return res.status(400).json({ success: false, errorKind: "invalid_coordinates", error: "Invalid drag coordinates" });
        }
        const steps = Math.max(6, Math.min(24, Math.ceil(Math.hypot(toX - fromX, toY - fromY) / 40)));
        let moves = "";
        for (let i = 1; i <= steps; i++) {
          const ix = Math.round(fromX + ((toX - fromX) * i) / steps);
          const iy = Math.round(fromY + ((toY - fromY) * i) / steps);
          moves += `[void][W.U32]::SetCursorPos(${ix},${iy}); Start-Sleep -Milliseconds 12; `;
        }
        script =
          USER32_PINVOKE +
          `[void][W.U32]::SetCursorPos(${fromX},${fromY}); Start-Sleep -Milliseconds 80; ` +
          `[W.U32]::mouse_event(2,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 60; ` +
          moves +
          `[void][W.U32]::SetCursorPos(${toX},${toY}); Start-Sleep -Milliseconds 40; ` +
          `[W.U32]::mouse_event(4,0,0,0,[UIntPtr]::Zero); Write-Output (\"POS {0} {1}\" -f ${toX},${toY})`;
        break;
      }
      default:
        return res.status(400).json({ success: false, errorKind: "invalid_input", error: `Unknown mouse action "${String(action)}"` });
    }

    const stdout = await runMouseScript(script);

    if (stdout.includes("POS")) {
      return res.json({ success: true, position: parsePos(stdout) });
    }
    if (stdout.includes("BOUNDS")) {
      const m = stdout.match(/BOUNDS (-?\d+) (-?\d+) (\d+) (\d+)/);
      if (!m) return res.json({ success: false, errorKind: "backend_failed", error: "Could not parse screen bounds" });
      return res.json({
        success: true,
        bounds: { x: parseInt(m[1], 10), y: parseInt(m[2], 10), width: parseInt(m[3], 10), height: parseInt(m[4], 10) },
      });
    }
    if (stdout.includes("OK")) {
      return res.json({ success: true });
    }
    return res.json({ success: false, errorKind: "backend_failed", error: "Mouse action produced no recognizable output" });
  } catch (err: any) {
    const message = String(err?.message || err);
    const timedOut = (err as any)?.killed === true || message.toLowerCase().includes("timed out");
    return res.json({
      success: false,
      errorKind: timedOut ? "timeout" : "backend_failed",
      error: timedOut ? "Mouse action timed out" : message.slice(0, 300),
    });
  }
});

// ---- Keyboard control (Phase 6) ----
// SendInput-based keyboard injection sharing the persistent PowerShell worker.
// KEYEVENTF_UNICODE types text without simulating per-character keypresses and
// without touching the clipboard. The BROWSER enforces the 'keyboard.control'
// permission and validates key names before ever calling this endpoint; this
// endpoint re-validates everything server-side.

const CSHARP_KBD = `using System; using System.Runtime.InteropServices; namespace W { public static class Kbd {
[StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
[StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public uint pad0; [FieldOffset(0)] public uint pad1; [FieldOffset(0)] public uint pad2; }
[StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
[StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
const uint KEYUP = 2; const uint UNICODE = 4; const uint KEYBOARD = 1;
[DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
static INPUT Mk(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = KEYBOARD; i.U.ki.wVk = vk; i.U.ki.wScan = scan; i.U.ki.dwFlags = flags; return i; }
static int Send(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = KEYBOARD; i.U.ki.wVk = vk; i.U.ki.wScan = scan; i.U.ki.dwFlags = flags; return (int)SendInput(1, new INPUT[]{i}, Marshal.SizeOf(typeof(INPUT))); }
public static string TypeText(string text, int delayMs) { int ok = 0; foreach (char c in text) { if (c == 13) continue; if (c == 10) { int d = Send(13, 0, 0); System.Threading.Thread.Sleep(delayMs); int u = Send(13, 0, KEYUP); System.Threading.Thread.Sleep(delayMs); if (d != 0 && u != 0) ok++; continue; } int dd = Send(0, (ushort)c, UNICODE); System.Threading.Thread.Sleep(delayMs); int uu = Send(0, (ushort)c, UNICODE | KEYUP); System.Threading.Thread.Sleep(delayMs); if (dd != 0 && uu != 0) ok++; } return "SENT " + ok; }
public static string Tap(ushort vk) { int d = Send(vk, 0, 0); System.Threading.Thread.Sleep(15); int u = Send(vk, 0, KEYUP); return (d != 0 && u != 0) ? "TAP " + vk : "TAPFAIL " + vk; }
public static string Down(ushort vk) { return Send(vk, 0, 0) != 0 ? "DOWN " + vk : "DOWNFAIL " + vk; }
public static string Up(ushort vk) { return Send(vk, 0, KEYUP) != 0 ? "UP " + vk : "UPFAIL " + vk; }
} }`;

function kbdPrelude(): string {
  // Compile the SendInput wrapper once per worker process (guarded — Add-Type
  // throws if the type already exists). The C# is collapsed to a SINGLE line:
  // the worker protocol is line-based, and single-quoted PS strings can hold
  // the whole source (it contains no single quotes). -Name/-Namespace are NOT
  // valid with -TypeDefinition, so the namespace lives inside the C# source.
  const csharp = CSHARP_KBD.replace(/\r?\n/g, ' ');
  return `if (-not ([System.Management.Automation.PSTypeName]'W.Kbd').Type) { Add-Type -TypeDefinition '${csharp}' }; `;
}

function psEscapeText(text: string): string {
  // Escape for a PowerShell double-quoted string. Newlines MUST become
  // backtick escapes (a raw newline would split the line-based worker
  // protocol) — inserted AFTER backtick-escaping so they are not doubled.
  return text
    .replace(/`/g, '``')
    .replace(/"/g, '`"')
    .replace(/\$/g, '`$')
    .replace(/\r\n/g, '`r`n')
    .replace(/\n/g, '`n')
    .replace(/\r/g, '`r');
}

function vkFor(key: string): number | null {
  const k = key.trim().toLowerCase();
  const named: Record<string, number> = {
    enter: 13, return: 13, escape: 27, esc: 27, tab: 9, backspace: 8, delete: 46, del: 46,
    insert: 45, space: 32, left: 37, up: 38, right: 39, down: 40,
    home: 36, end: 35, pageup: 33, pagedown: 34,
    minus: 189, equal: 187, comma: 188, period: 190, slash: 191, backquote: 192,
    bracketleft: 219, backslash: 220, bracketright: 221, semicolon: 186, quote: 222,
    ctrl: 17, control: 17, alt: 18, shift: 16, win: 91, cmd: 91, meta: 91,
  };
  if (named[k] !== undefined) return named[k];
  if (/^[a-z]$/.test(k)) return 65 + (k.charCodeAt(0) - 97);
  if (/^[0-9]$/.test(k)) return 48 + parseInt(k, 10);
  const fMatch = k.match(/^f([1-9]|1[0-2])$/);
  if (fMatch) return 111 + parseInt(fMatch[1], 10);
  return null;
}

app.post("/api/computer/keyboard", async (req, res) => {
  const { action } = req.body || {};
  try {
    let script = "";
    let expectSent = false;
    // Default worker lifetime; typing scales it below (each character costs a
    // SendInput pair + delay — a 2-5k-character type needs far more than the
    // base 20 s or the injection dies mid-text).
    let psTimeoutMs = MOUSE_PS_TIMEOUT_MS;

    switch (action) {
      case "type": {
        const text = typeof req.body.text === "string" ? req.body.text : "";
        if (!text.trim() || text.length > 5000) {
          return res.status(400).json({ success: false, errorKind: "invalid_input", error: "Invalid text" });
        }
        const clean = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
        script =
          kbdPrelude() +
          `$r = [W.Kbd]::TypeText("${psEscapeText(clean)}", 5); Write-Output $r`;
        expectSent = true;
        // Per-char pacing ≈ 12 ms (5 ms + 5 ms sleeps + SendInput overhead);
        // scale the worker lifetime so long text is never killed mid-injection.
        psTimeoutMs = MOUSE_PS_TIMEOUT_MS + clean.length * 15 + 5000;
        break;
      }
      case "key": {
        const vk = vkFor(String(req.body.key ?? ""));
        if (vk === null) return res.status(400).json({ success: false, errorKind: "invalid_key", error: "Unknown key" });
        script = kbdPrelude() + `Write-Output ([W.Kbd]::Tap(${vk}))`;
        break;
      }
      case "hotkey": {
        const mods = Array.isArray(req.body.modifiers) ? req.body.modifiers : [];
        const vk = vkFor(String(req.body.key ?? ""));
        if (vk === null) return res.status(400).json({ success: false, errorKind: "invalid_key", error: "Unknown key" });
        const modVks: number[] = [];
        for (const mod of mods) {
          const m = vkFor(String(mod));
          if (m === null || ![16, 17, 18, 91].includes(m)) {
            return res.status(400).json({ success: false, errorKind: "invalid_key", error: "Unknown modifier" });
          }
          modVks.push(m);
        }
        if (modVks.length === 0 || modVks.length > 4) {
          return res.status(400).json({ success: false, errorKind: "invalid_input", error: "Invalid modifier count" });
        }
        const downs = modVks.map((m) => `[void][W.Kbd]::Down(${m}); Start-Sleep -Milliseconds 20; `).join("");
        const upsReversed = [...modVks].reverse().map((m) => `[void][W.Kbd]::Up(${m}); `).join("");
        // Modifiers are always released, even if the key tap throws (finally).
        script =
          kbdPrelude() +
          `try { ${downs}Start-Sleep -Milliseconds 40; [void][W.Kbd]::Tap(${vk}); Write-Output OK } finally { Start-Sleep -Milliseconds 20; ${upsReversed}Write-Output MODUP }`;
        break;
      }
      case "key_down": {
        const vk = vkFor(String(req.body.key ?? ""));
        if (vk === null) return res.status(400).json({ success: false, errorKind: "invalid_key", error: "Unknown key" });
        script = kbdPrelude() + `Write-Output ([W.Kbd]::Down(${vk}))`;
        break;
      }
      case "key_up": {
        const vk = vkFor(String(req.body.key ?? ""));
        if (vk === null) return res.status(400).json({ success: false, errorKind: "invalid_key", error: "Unknown key" });
        script = kbdPrelude() + `Write-Output ([W.Kbd]::Up(${vk}))`;
        break;
      }
      default:
        return res.status(400).json({ success: false, errorKind: "invalid_input", error: `Unknown keyboard action "${String(action)}"` });
    }

    const stdout = await runMouseScript(script, psTimeoutMs);

    if (expectSent) {
      const m = stdout.match(/SENT (\d+)/);
      if (!m) return res.json({ success: false, errorKind: "backend_failed", error: "Type action produced no recognizable output" });
      const sent = parseInt(m[1], 10);
      // Honest delivery evidence (spec §13): report the real injected count and
      // fail when SendInput rejected every keystroke. A partial count is still
      // success (side effects already happened) but the shortfall is visible.
      const expected = String(req.body.text).replace(/\r/g, "").length;
      if (sent === 0) {
        return res.json({ success: false, errorKind: "backend_failed", error: "SendInput rejected every keystroke — nothing was typed" });
      }
      return res.json({ success: true, sent, expected });
    }
    if (/FAIL/.test(stdout)) {
      return res.json({ success: false, errorKind: "backend_failed", error: "SendInput rejected the keyboard action — it was not delivered" });
    }
    if (stdout.includes("MODUP") || stdout.includes("OK") || stdout.includes("TAP ") || stdout.includes("DOWN ") || stdout.includes("UP ")) {
      return res.json({ success: true });
    }
    return res.json({ success: false, errorKind: "backend_failed", error: "Keyboard action produced no recognizable output" });
  } catch (err: any) {
    const message = String(err?.message || err);
    const timedOut = message.toLowerCase().includes("timed out");
    return res.json({
      success: false,
      errorKind: timedOut ? "timeout" : "backend_failed",
      error: timedOut ? "Keyboard action timed out" : message.slice(0, 300),
    });
  }
});

// ---- Browser agent endpoints (Phase 8) ----
// Krisha-controlled headless Chrome/Edge over CDP (see browserCdp.ts). The
// endpoint layer exposes TYPED actions only (navigate / click-by-text /
// type-into-field / read-state) — callers cannot inject arbitrary JS.
import {
  browserPageState,
  browserNavigate,
  browserEvaluate,
  browserListTabs,
} from "./browserCdp";

function assertSafeHttpUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Malformed URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme "${parsed.protocol}" — only http/https are allowed`);
  }
  return parsed;
}

app.post("/api/browser/state", async (req, res) => {
  try {
    const state = await browserPageState();
    let tabs: any[] = [];
    try {
      tabs = await browserListTabs();
    } catch {
      // tabs are best-effort
    }
    res.json({ success: true, state, tabs });
  } catch (err: any) {
    res.json({ success: false, error: String(err?.message || err).slice(0, 300) });
  }
});

app.post("/api/browser/navigate", async (req, res) => {
  try {
    const url = assertSafeHttpUrl(String(req.body?.url ?? "")).toString();
    // SPF EP-8 — navigation URL gate: query strings can carry screen-derived
    // text to external sites (e.g. agent searching for screen content via a
    // search-engine URL). Sensitive or uncertain content blocks navigation.
    const navSpf = spfFirewall.inspectUrl(url, {
      destination: "browser:navigate:" + (new URL(url).host),
      payloadKind: "url",
      transport: "prompt",
    });
    spfAuditDurable("/api/browser/navigate", "browser:navigate", navSpf);
    if (navSpf.decision === "block") {
      return res.json({ success: false, error: "Navigation blocked by the Screen Privacy Firewall", spfBlocked: true, spfReason: navSpf.reason });
    }
    const result = await browserNavigate(url);
    res.json({ success: true, ...result });
  } catch (err: any) {
    if (err?.name === "SpfBlockedError") {
      res.json({ success: false, error: "Navigation blocked by the Screen Privacy Firewall", spfBlocked: true });
      return;
    }
    res.json({ success: false, error: String(err?.message || err).slice(0, 300) });
  }
});

async function browserHistoryAction(req: any, res: any, expression: string) {
  try {
    await browserEvaluate(expression);
    const state = await browserPageState();
    res.json({ success: true, url: state.url, title: state.title });
  } catch (err: any) {
    res.json({ success: false, error: String(err?.message || err).slice(0, 300) });
  }
}

app.post("/api/browser/back", async (req, res) => browserHistoryAction(req, res, "history.back()"));
app.post("/api/browser/forward", async (req, res) => browserHistoryAction(req, res, "history.forward()"));
app.post("/api/browser/refresh", async (req, res) => browserHistoryAction(req, res, "location.reload()"));

app.post("/api/browser/click", async (req, res) => {
  try {
    const text = String(req.body?.text ?? "").trim();
    const kind = ["link", "button", "any"].includes(req.body?.kind) ? req.body.kind : "any";
    if (!text) return res.json({ success: false, error: "Missing click target text" });
    const result = await browserEvaluate<any>(
      `(() => {
        const q = ${JSON.stringify(text.toLowerCase())};
        const kind = ${JSON.stringify(kind)};
        const trim = s => (s || "").trim().toLowerCase();
        const cands = [];
        if (kind !== "button") cands.push(...[...document.querySelectorAll("a[href]")]);
        if (kind !== "link") cands.push(...[...document.querySelectorAll("button, [role=button], input[type=submit], input[type=button]")]);
        for (const el of cands) {
          const t = trim(el.innerText || el.value || el.getAttribute("aria-label"));
          if (t && (t === q || t.includes(q))) {
            el.scrollIntoView({ block: "center" });
            el.click();
            return JSON.stringify({ clicked: t.slice(0, 80), href: el.href || null });
          }
        }
        return JSON.stringify({ clicked: null });
      })()`
    );
    const parsed = JSON.parse(result);
    if (!parsed.clicked) {
      return res.json({ success: false, errorKind: "not_found", error: `No visible link/button matching "${text.slice(0, 60)}" on the page` });
    }
    const state = await browserPageState();
    res.json({ success: true, clicked: parsed.clicked, href: parsed.href, url: state.url, title: state.title });
  } catch (err: any) {
    res.json({ success: false, error: String(err?.message || err).slice(0, 300) });
  }
});

app.post("/api/browser/type", async (req, res) => {
  try {
    const match = String(req.body?.match ?? "").trim();
    const text = String(req.body?.text ?? "");
    if (!match) return res.json({ success: false, error: "Missing field match" });
    if (!text || text.length > 2000) return res.json({ success: false, errorKind: "invalid_input", error: "Invalid text" });
    const result = await browserEvaluate<any>(
      `(() => {
        const m = ${JSON.stringify(match.toLowerCase())};
        const text = ${JSON.stringify(text)};
        const fields = [...document.querySelectorAll("input, textarea")].filter(f => {
          const s = getComputedStyle(f);
          return s.display !== "none" && s.visibility !== "hidden";
        });
        const score = f => {
          const hay = [f.placeholder, f.name, f.id, f.getAttribute("aria-label"), (f.labels && f.labels[0] && f.labels[0].innerText)].map(x => (x || "").toLowerCase());
          if (hay.some(h => h && (h.includes(m) || m.includes(h)))) return 2;
          return hay.some(h => h && m.split(/\\s+/).some(w => w.length > 2 && h.includes(w))) ? 1 : 0;
        };
        let best = null, bestScore = 0;
        for (const f of fields) { const s = score(f); if (s > bestScore) { bestScore = s; best = f; } }
        if (!best || bestScore === 0) return JSON.stringify({ typed: false });
        best.scrollIntoView({ block: "center" });
        best.focus();
        const proto = best.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
        setter.call(best, text);
        best.dispatchEvent(new Event("input", { bubbles: true }));
        best.dispatchEvent(new Event("change", { bubbles: true }));
        return JSON.stringify({ typed: true, field: (best.name || best.placeholder || best.id || best.type || "").slice(0, 60) });
      })()`
    );
    const parsed = JSON.parse(result);
    if (!parsed.typed) {
      return res.json({ success: false, errorKind: "not_found", error: `No visible field matching "${match.slice(0, 60)}" on the page` });
    }
    res.json({ success: true, field: parsed.field });
  } catch (err: any) {
    res.json({ success: false, error: String(err?.message || err).slice(0, 300) });
  }
});

app.post("/api/browser/scroll", async (req, res) => {
  try {
    const deltaY = Math.max(-20000, Math.min(20000, Math.round(Number(req.body?.deltaY) || 0)));
    await browserEvaluate(`window.scrollBy(0, ${deltaY}); "scrolled"`);
    res.json({ success: true });
  } catch (err: any) {
    res.json({ success: false, error: String(err?.message || err).slice(0, 300) });
  }
});

app.post("/api/browser/tabs", async (req, res) => {
  try {
    const tabs = await browserListTabs();
    res.json({ success: true, tabs });
  } catch (err: any) {
    res.json({ success: false, error: String(err?.message || err).slice(0, 300) });
  }
});

// ---- Deep research capability endpoints (additional capability, outside the
// numbered roadmap — NOT roadmap Phase 16) ----
// Server-side search + page fetch for the research subsystem: same-origin
// pattern used by every other agent backend (no browser CORS limits, no new
// dependencies — regex HTML parsing only). Everything is bounded (timeouts,
// response caps) and refuses private network targets (server-side SSRF guard).
const RESEARCH_FETCH_TIMEOUT_MS = 15_000;
const RESEARCH_MAX_BYTES = 1_500_000;
const RESEARCH_TEXT_MAX_CHARS = 40_000;

const RESEARCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 KrishaResearch/1.0";

function isPrivateResearchHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "[::1]" || host === "0.0.0.0") return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

function decodeResearchEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => {
      const num = Number(code);
      return num > 0 && num < 0x10ffff ? String.fromCodePoint(num) : "";
    });
}

function stripResearchTags(html: string): string {
  return decodeResearchEntities(html.replace(/<[^>]*>/g, " "));
}

/** Resolve a DuckDuckGo result href (direct URL or /l/?uddg= redirect). */
function resolveDdgHref(href: string): string | null {
  let value = href.trim();
  if (value.startsWith("//")) value = `https:${value}`;
  try {
    const parsed = new URL(value, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    if (parsed.hostname.includes("duckduckgo.com")) return null;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

async function duckDuckGoSearch(query: string, variant: "html" | "lite"): Promise<{ url: string; title: string; snippet: string }[]> {
  const target =
    variant === "html"
      ? `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
      : `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESEARCH_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(target, {
      headers: { "User-Agent": RESEARCH_UA, "Accept": "text/html" },
      signal: controller.signal,
    });
    if (!resp.ok) return [];
    const html = (await resp.text()).slice(0, RESEARCH_MAX_BYTES);

    const anchorRe =
      variant === "html"
        ? /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
        : /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRe =
      variant === "html"
        ? /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g
        : /<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g;

    const anchors = [...html.matchAll(anchorRe)].slice(0, 10);
    const snippets = [...html.matchAll(snippetRe)].slice(0, 10);

    const results: { url: string; title: string; snippet: string }[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < anchors.length; i++) {
      // Skip sponsored/internal links before resolving (ads, y.js redirects).
      if (/duckduckgo\.com\/y\.js|[?&]ad_domain=|ad_provider=/i.test(anchors[i][1])) continue;
      const url = resolveDdgHref(anchors[i][1]);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const snippet = snippets[i] ? stripResearchTags(snippets[i][1]).replace(/\s+/g, " ").trim().slice(0, 300) : "";
      results.push({
        url,
        title: stripResearchTags(anchors[i][2]).replace(/\s+/g, " ").trim().slice(0, 200),
        snippet,
      });
      if (results.length >= 8) break;
    }
    return results;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** HTML → bounded readable text (scripts/styles/comments stripped). */
function researchHtmlToText(html: string): string {
  return decodeResearchEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(?:p|div|section|article|li|h[1-6]|tr|blockquote)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]*>/g, " ")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

/** Bing search via its stable RSS output (bot-tolerant fallback engine). */
async function bingSearch(query: string): Promise<{ url: string; title: string; snippet: string }[]> {
  const target = `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&count=10`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESEARCH_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(target, {
      headers: { "User-Agent": RESEARCH_UA, "Accept": "application/rss+xml, application/xml, text/xml" },
      signal: controller.signal,
    });
    if (!resp.ok) return [];
    const xml = (await resp.text()).slice(0, RESEARCH_MAX_BYTES).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");

    const results: { url: string; title: string; snippet: string }[] = [];
    const seen = new Set<string>();
    for (const item of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const block = item[1];
      const tag = (name: string): string => {
        const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
        return m ? m[1].trim() : "";
      };
      const url = decodeResearchEntities(tag("link"));
      if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
      seen.add(url);
      results.push({
        url,
        title: decodeResearchEntities(tag("title")).replace(/\s+/g, " ").slice(0, 200),
        snippet: stripResearchTags(decodeResearchEntities(tag("description"))).replace(/\s+/g, " ").slice(0, 300),
      });
      if (results.length >= 8) break;
    }
    return results;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

app.post("/api/research/search", async (req, res) => {
  const query = String(req.body?.query ?? "").trim().slice(0, 300);
  if (!query) {
    return res.json({ success: false, error: "Missing search query" });
  }
  // SPF EP-7 — research-query gate. Research queries can embed screen-derived
  // text (e.g. an agent researching an error visible on screen). Confident
  // secrets are redacted from the query; unredactable or uncertain content
  // blocks the search (strict screen-provenance transport).
  const searchSpf = spfFirewall.inspectText(query, {
    destination: "web-search:duckduckgo+bing",
    payloadKind: "text",
    transport: "prompt",
  });
  spfAuditDurable("/api/research/search", "web-search:duckduckgo+bing", searchSpf);
  if (searchSpf.decision === "block") {
    return res.json({ success: false, error: "Query blocked by the Screen Privacy Firewall", spfBlocked: true, spfReason: searchSpf.reason });
  }
  const spfSafeQuery = (searchSpf.redactedText ?? query).trim();
  // Context Engine v1: cache-first, network-last — a still-valid cached result
  // set for this exact query is served instead of re-hitting the public
  // engines (fresh-only: stale entries are never served for research).
  // SPF EP-7: the cache key and every engine call use the SPF-redacted query.
  const cached = getContextEngine().lookupKnowledge(`research_search:${spfSafeQuery}`);
  if (cached.hit && Array.isArray(cached.value) && cached.value.length > 0) {
    return res.json({ success: true, engine: "cache", cached: true, results: cached.value });
  }
  try {
    // Engine waterfall: DuckDuckGo (html → lite) then Bing RSS. The public
    // engines rate-limit by IP, so a fallback keeps research working.
    const engines: { name: string; run: () => Promise<{ url: string; title: string; snippet: string }[]> }[] = [
      { name: "duckduckgo-html", run: () => duckDuckGoSearch(spfSafeQuery, "html") },
      { name: "duckduckgo-lite", run: () => duckDuckGoSearch(spfSafeQuery, "lite") },
      { name: "bing", run: () => bingSearch(spfSafeQuery) },
    ];
    for (const engine of engines) {
      const results = await engine.run();
      if (results.length > 0) {
        // Post-result caching (spec §13): bounded TTL; oversized result sets
        // are silently skipped by the cache's size cap — never truncated.
        getContextEngine().cacheKnowledge(`research_search:${spfSafeQuery}`, results, {
          ttlMs: 6 * 60 * 60_000,
          source: "research_search",
        });
        return res.json({ success: true, engine: engine.name, results });
      }
    }
    return res.json({ success: false, error: "No search results (search engines unreachable or blocked)" });
  } catch (err: any) {
    res.json({ success: false, error: String(err?.message || err).slice(0, 300) });
  }
});

app.post("/api/research/fetch", async (req, res) => {
  let parsed: URL;
  try {
    parsed = assertSafeHttpUrl(String(req.body?.url ?? ""));
  } catch (err: any) {
    return res.json({ success: false, error: String(err?.message || err).slice(0, 300) });
  }
  // SPF EP-7b — the fetch URL itself is an outbound string: a URL carrying
  // credentials/keys/OTP-shaped data is blocked before the request is made.
  const fetchUrlSpf = spfFirewall.inspectUrl(parsed.toString(), {
    destination: "research-fetch:" + parsed.host,
    payloadKind: "url",
    transport: "http-url",
  });
  spfAuditDurable("/api/research/fetch", "research-fetch:" + parsed.host, fetchUrlSpf);
  if (fetchUrlSpf.decision === "block") {
    return res.json({ success: false, error: "URL blocked by the Screen Privacy Firewall", spfBlocked: true, spfReason: fetchUrlSpf.reason });
  }
  if (isPrivateResearchHost(parsed.hostname)) {
    return res.json({ success: false, error: "Refusing to fetch private network addresses" });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESEARCH_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(parsed.toString(), {
      headers: { "User-Agent": RESEARCH_UA, "Accept": "text/html,text/plain" },
      signal: controller.signal,
      redirect: "follow",
    });
    const contentType = resp.headers.get("content-type") ?? "";
    if (!/text\/html|text\/plain|application\/xhtml|application\/json/i.test(contentType)) {
      return res.json({ success: false, error: `Unsupported content type "${contentType.split(";")[0] || "unknown"}" — only readable pages can be inspected` });
    }
    if (!resp.ok) {
      return res.json({ success: false, error: `Source responded with HTTP ${resp.status}` });
    }
    const raw = (await resp.text()).slice(0, RESEARCH_MAX_BYTES);
    const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? decodeResearchEntities(titleMatch[1]).replace(/\s+/g, " ").trim().slice(0, 200) : "";
    const isHtml = /text\/html|application\/xhtml/i.test(contentType);
    const text = (isHtml ? researchHtmlToText(raw) : decodeResearchEntities(raw).replace(/[ \t]+/g, " ")).slice(0, RESEARCH_TEXT_MAX_CHARS);
    if (text.trim().length < 40) {
      return res.json({ success: false, error: "Page contained no readable text" });
    }
    res.json({ success: true, url: resp.url || parsed.toString(), title, text });
  } catch (err: any) {
    const reason = controller.signal.aborted ? "Source fetch timed out" : String(err?.message || err);
    res.json({ success: false, error: reason.slice(0, 300) });
  } finally {
    clearTimeout(timer);
  }
});

// ---- Filesystem + application agent endpoints (Phase 9) ----
// Real-disk operations with strict path safety (allowed roots + system-dir
// denylist for mutations) and evidence-based verification. Application
// operations are allowlist-based; no arbitrary command execution.
import * as sys from './systemAgentServer';
// Office files (spreadsheet/presentation): pure-JS, lazily imported, fully
// local generation + bounded reading (officeCore caps enforce the 8 GB RAM
// discipline). See officeCore.ts for the design constraints.
import * as office from './officeCore';

function fsResult(res: any, fn: () => Promise<unknown>) {
  fn()
    .then((result) => res.json({ success: true, result }))
    .catch((err: any) => res.json({ success: false, error: String(err?.message || err).slice(0, 300) }));
}

app.post('/api/office/spreadsheet/create', (req, res) =>
  fsResult(res, () => office.createSpreadsheet({
    path: String(req.body?.path ?? ''),
    sheets: Array.isArray(req.body?.sheets) ? req.body.sheets : undefined,
    overwrite: req.body?.overwrite === true,
  }))
);
app.post('/api/office/spreadsheet/read', (req, res) =>
  fsResult(res, () => office.readSpreadsheet({
    path: String(req.body?.path ?? ''),
    sheet: typeof req.body?.sheet === 'string' ? req.body.sheet : undefined,
    maxRows: Number.isFinite(Number(req.body?.maxRows)) ? Number(req.body.maxRows) : undefined,
  }))
);
app.post('/api/office/spreadsheet/edit', (req, res) =>
  fsResult(res, () => office.editSpreadsheet({
    path: String(req.body?.path ?? ''),
    ops: Array.isArray(req.body?.ops) ? req.body.ops : [],
    createIfMissing: req.body?.createIfMissing === true,
  }))
);
app.post('/api/office/presentation/create', (req, res) =>
  fsResult(res, () => office.createPresentation({
    path: String(req.body?.path ?? ''),
    title: typeof req.body?.title === 'string' ? req.body.title : undefined,
    subject: typeof req.body?.subject === 'string' ? req.body.subject : undefined,
    slides: Array.isArray(req.body?.slides) ? req.body.slides : [],
    overwrite: req.body?.overwrite === true,
  }))
);

// ---- Office content generation (research tie-in) ----
// "Create a presentation about X" / "spreadsheet of Y": the MODEL drafts the
// STRUCTURE as strict JSON (text-only call — no screenshots, no files
// uploaded), officeCore validates it against the hard caps and writes the
// local file. The file itself never leaves the machine. This is the office
// analogue of research: online content acquisition, offline artifact.
const officeGenTimestamps: number[] = [];
const OFFICE_GEN_MAX_PER_WINDOW = 6;
const OFFICE_GEN_WINDOW_MS = 60_000;

function parseModelJson(text: string): unknown {
  // Tolerate code fences; fail honestly on malformed output.
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    throw new Error("The model returned content that is not valid JSON — try rephrasing the request");
  }
}

app.post('/api/office/generate', async (req, res) => {
  try {
    const kind = req.body?.kind === 'spreadsheet' ? 'spreadsheet' : req.body?.kind === 'presentation' ? 'presentation' : null;
    const topic = String(req.body?.topic ?? '').trim();
    if (!kind) return res.status(400).json({ success: false, error: "kind must be 'presentation' or 'spreadsheet'" });
    if (!topic || topic.length > 400) return res.status(400).json({ success: false, error: "A topic (max 400 chars) is required" });
    if (!process.env.GEMINI_API_KEY) {
      return res.json({
        success: false,
        error: "Content generation needs GEMINI_API_KEY (offline mode still works: create the file directly and fill it with spreadsheet.edit)",
      });
    }

    // Bounded quota: a generation run is one model call + one file write.
    const now = Date.now();
    while (officeGenTimestamps.length > 0 && now - officeGenTimestamps[0] > OFFICE_GEN_WINDOW_MS) officeGenTimestamps.shift();
    if (officeGenTimestamps.length >= OFFICE_GEN_MAX_PER_WINDOW) {
      return res.status(429).json({ success: false, error: "rate_limited", group: "office-generate" });
    }
    officeGenTimestamps.push(now);

    const ai = getGenAI();
    let result: office.OfficeWriteResult;
    if (kind === 'presentation') {
      const requestedSlides = Math.min(Math.max(3, Number(req.body?.slides) || 6), 12);
      const gen = await generateContentWithFallback(ai, {
        contents: [{
          role: "user",
          parts: [{ text: `Create presentation content about: ${topic}` }],
        }],
        systemInstruction:
          `You draft presentation slide content. Reply with STRICT JSON only, no markdown fences: ` +
          `{"title": string (max 100 chars), "slides": [{"title": string (max 120 chars), "bullets": string[] (3-6 bullets, each max 140 chars, concrete and factual), "notes": string (optional speaker notes, max 400 chars)}]}. ` +
          `Exactly ${requestedSlides} slides. No preamble, no explanation — JSON only.`,
        temperature: 0.7,
        responseMimeType: "application/json",
      });
      const parsed = parseModelJson(gen.text) as { title?: unknown; slides?: unknown };
      const slidesRaw = Array.isArray(parsed.slides) ? parsed.slides : [];
      if (slidesRaw.length === 0) throw new Error("The model returned no slides — try rephrasing the topic");
      const slides = slidesRaw.slice(0, office.OFFICE_LIMITS.MAX_SLIDES).map((s: any, i: number) => ({
        title: String(s?.title ?? `Slide ${i + 1}`),
        bullets: Array.isArray(s?.bullets) ? s.bullets.map((b: unknown) => String(b)) : [],
        notes: typeof s?.notes === 'string' ? s.notes : undefined,
      }));
      result = await office.createPresentation({
        path: String(req.body?.path ?? ''),
        title: typeof parsed.title === 'string' ? parsed.title : topic,
        subject: topic,
        slides,
        overwrite: req.body?.overwrite === true,
      });
    } else {
      const columnsInput = Array.isArray(req.body?.columns)
        ? req.body.columns.map((c: unknown) => String(c)).filter(Boolean).slice(0, office.OFFICE_LIMITS.MAX_COLS)
        : undefined;
      const requestedRows = Math.min(Math.max(5, Number(req.body?.rows) || 20), 100);
      const gen = await generateContentWithFallback(ai, {
        contents: [{
          role: "user",
          parts: [{ text: `Generate spreadsheet data about: ${topic}` }],
        }],
        systemInstruction:
          `You draft spreadsheet data. Reply with STRICT JSON only, no markdown fences: ` +
          `{"columns": string[] (max 8 short column headers), "rows": array of rows, each an array matching the columns ` +
          `(values as plain strings or numbers, no units in number cells, max 120 chars per cell)}. ` +
          `Generate exactly ${requestedRows} data rows of accurate, useful content. No preamble — JSON only.` +
          (columnsInput && columnsInput.length > 0 ? ` Use EXACTLY these columns in this order: ${columnsInput.join(" | ")}.` : ""),
        temperature: 0.6,
        responseMimeType: "application/json",
      });
      const parsed = parseModelJson(gen.text) as { columns?: unknown; rows?: unknown };
      const columns = (Array.isArray(parsed.columns) ? parsed.columns.map((c) => String(c)) : columnsInput ?? ["Item", "Details"]).slice(0, office.OFFICE_LIMITS.MAX_COLS);
      const rowsRaw = Array.isArray(parsed.rows) ? parsed.rows : [];
      if (rowsRaw.length === 0) throw new Error("The model returned no rows — try rephrasing the topic");
      const rows: office.OfficeRow[] = rowsRaw.slice(0, office.OFFICE_LIMITS.MAX_ROWS).map((r: unknown) =>
        Array.isArray(r) ? r.map((v) => {
          const s = typeof v === 'number' ? v : String(v ?? '');
          return typeof s === 'string' && s.length > office.OFFICE_LIMITS.MAX_CELL_CHARS ? s.slice(0, office.OFFICE_LIMITS.MAX_CELL_CHARS) : s;
        }) : [String(r)]
      );
      result = await office.createSpreadsheet({
        path: String(req.body?.path ?? ''),
        sheets: [{ name: 'Data', rows: [columns as office.OfficeRow, ...rows] }],
        overwrite: req.body?.overwrite === true,
      });
    }
    res.json({ success: true, result });
  } catch (err: any) {
    res.json({ success: false, error: String(err?.message || err).slice(0, 300) });
  }
});

app.post('/api/fs/list', (req, res) => fsResult(res, () => sys.fsList(String(req.body?.path ?? ''))));
app.post('/api/fs/inspect', (req, res) => fsResult(res, () => sys.fsInspect(String(req.body?.path ?? ''))));
app.post('/api/fs/search', (req, res) => fsResult(res, () => sys.fsSearch(String(req.body?.root ?? ''), String(req.body?.query ?? ''), Number(req.body?.maxDepth) || 4)));
app.post('/api/fs/read', (req, res) => fsResult(res, () => sys.fsReadFile(String(req.body?.path ?? ''), Number(req.body?.offset) || 0)));
app.post('/api/fs/create', (req, res) => fsResult(res, () => sys.fsCreate(String(req.body?.path ?? ''), req.body?.type === 'dir' ? 'dir' : 'file', typeof req.body?.content === 'string' ? req.body.content : undefined)));
app.post('/api/fs/rename', (req, res) => fsResult(res, () => sys.fsRename(String(req.body?.path ?? ''), String(req.body?.newName ?? ''))));
app.post('/api/fs/copy', (req, res) => fsResult(res, () => sys.fsCopy(String(req.body?.from ?? ''), String(req.body?.to ?? ''), req.body?.overwrite === true)));
app.post('/api/fs/move', (req, res) => fsResult(res, () => sys.fsMove(String(req.body?.from ?? ''), String(req.body?.to ?? ''), req.body?.overwrite === true)));
app.post('/api/fs/delete', (req, res) => fsResult(res, () => sys.fsDelete(String(req.body?.path ?? ''), req.body?.recursive === true)));
app.post('/api/fs/open', (req, res) => fsResult(res, () => sys.fsOpenWithAssociation(String(req.body?.path ?? ''))));

// ---- E5 M1: server-authoritative safety status + activation ----
// There is deliberately NO HTTP deactivation endpoint: deactivation runs
// exclusively through the recovery CLI + named pipe + credential.
app.get("/api/safety/stop", (req, res) => {
  res.json({ success: true, result: stopSnapshot() });
});
app.post("/api/safety/stop/activate", (req, res) => {
  if (!rateLimit("stop-activate", 5, 60_000)) {
    res.status(429).json({ success: false, error: "rate_limited" });
    return;
  }
  try {
    const result = activateStop(String(req.body?.reason ?? "operator requested emergency stop"), "http");
    res.json({ success: true, result: { ...result, snapshot: stopSnapshot() } });
  } catch (err) {
    res.status(409).json({ success: false, error: String((err as Error)?.message || err) });
  }
});

// ---- Operator session-permission mirroring ----
// The UI grants interactive-control permissions in its session when the
// operator explicitly asks for them ("move the mouse to X", "read my screen")
// — the established screen-observation doctrine: the explicit request IS the
// operator grant. Because the HTTP enforcement (E5 M1b) reads SERVER state,
// the UI mirrors that grant here so the same request can pass the
// authoritative boundary. Restricted to the three interactive-control
// domains — filesystem/terminal/vault stay server-default-deny; revocation is
// always accepted so the UI can match the server's revoke semantics.
const MIRRORABLE_PERMISSIONS = new Set(["screen.observation", "mouse.control", "keyboard.control"]);
app.post("/api/permissions/session", (req, res) => {
  if (!rateLimit("permissions-session", 20, 60_000)) {
    res.status(429).json({ success: false, error: "rate_limited" });
    return;
  }
  const grant = Array.isArray(req.body?.grant) ? req.body.grant.map(String) : [];
  const revoke = Array.isArray(req.body?.revoke) ? req.body.revoke.map(String) : [];
  const unknown = [...grant, ...revoke].filter((p) => !MIRRORABLE_PERMISSIONS.has(p));
  if (unknown.length > 0) {
    res.status(400).json({ success: false, error: `Not a mirrorable permission: ${unknown.join(", ")}` });
    return;
  }
  // Revoke first, then grant — a request carrying the same name in both is a
  // deliberate re-grant. Emergency stop stays authoritative: enforcement also
  // stop-blocks the side-effecting routes regardless of session grants.
  for (const p of revoke) serverPermissions.revokeSession(p);
  for (const p of grant) serverPermissions.grantSession(p);
  appendAuditSyncSafe({ kind: "session_permissions_mirrored", granted: grant, revoked: revoke });
  res.json({ success: true, granted: grant, revoked: revoke });
});

// ---- E5 H4: read-only runtime integrity status (no authorization change) ----
app.get("/api/integrity/status", (req, res) => {
  const report = lastIntegrityReport();
  if (!report) {
    res.json({ success: false, error: "integrity monitoring has not evaluated yet", intervalMs: configuredIntervalMs() });
    return;
  }
  res.json({ success: true, result: report, intervalMs: configuredIntervalMs() });
});

// ---- Phase A: process monitor read-only visibility (NO control surface) ----
// Health, counters, and a bounded recent-event view. `reconcile=1` triggers a
// bounded inventory drift correction against a live snapshot.
app.get("/api/processmonitor/status", async (req, res) => {
  try {
    const recent = Math.max(1, Math.min(200, Number(req.query.recent) || 50));
    let reconciled: { corrected: number; snapshotSize: number } | null = null;
    if (req.query.reconcile === "1") {
      reconciled = await processMonitor.reconcile();
    }
    res.json({
      status: processMonitor.status(),
      recentEvents: processMonitor.recentEvents(recent),
      reconciled,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "process monitor status failed" });
  }
});

// ---- Phase B: malware detection read-only visibility + on-demand assessment ----
// Detection/classification ONLY — no control endpoints exist for this subsystem.
app.get("/api/malwaredetect/status", async (req, res) => {
  try {
    const recent = Math.max(1, Math.min(200, Number(req.query.recent) || 50));
    const defender = await defenderSource.status();
    res.json({
      health: malwareEngine.health(),
      defender: {
        available: defender.available,
        amServiceEnabled: defender.amServiceEnabled,
        realTimeProtectionEnabled: defender.realTimeProtectionEnabled,
        behaviorMonitorEnabled: defender.behaviorMonitorEnabled,
        antivirusSignatureAgeDays: defender.antivirusSignatureAgeDays,
        quickScanAgeDays: defender.quickScanAgeDays,
        engineVersion: defender.engineVersion,
      },
      recentDetections: malwareEngine.recentDetections(recent),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "malware detection status failed" });
  }
});

// ---- Phase C: execution gate approval route ----
// Issues a single-use launch approval token after operator review.
// CONFIRMED_MALWARE returns null (non-overridable block).
app.post("/api/execgate/approve", async (req, res) => {
  try {
    const p = String(req.body?.path ?? "").trim();
    if (!p || p.length > 500) return res.status(400).json({ error: "path is required" });
    const identity = await fs.promises.stat(p).then(
      (s) => ({ path: p, mtimeMs: s.mtimeMs, size: s.size }),
      () => null
    );
    if (!identity) return res.status(400).json({ error: "executable not found" });
    const classification = await malwareEngine.assessFile(p);
    const token = executionGate.issueApproval(p, identity, classification.classification);
    if (!token) {
      return res.json({ approved: false, reason: "CONFIRMED_MALWARE cannot be approved — non-overridable", classification: classification.classification });
    }
    res.json({ approved: true, token: token.token, expiresAt: token.expiresAt, classification: classification.classification });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "exec-gate approval failed" });
  }
});

app.post("/api/malwaredetect/assess", async (req, res) => {
  try {
    const p = String(req.body?.path ?? "").trim();
    if (!p || p.length > 500) {
      return res.status(400).json({ error: "path is required (max 500 chars)" });
    }
    const record = await malwareEngine.assessFile(p);
    return res.json({ record });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "assessment failed" });
  }
});

// ---- Phase D.3/completion: threat containment (operator-approved, pinned identity) ----
// The request shape carries ONLY {pid, approvalToken} for containment —
// classification and process identity are established SERVER-SIDE (never
// client-supplied). Approval additionally requires the OPERATOR'S APPROVAL
// CREDENTIAL (proof of the human decision; enrolled via the recovery pipe):
// the server verifies it before minting a single-use token bound to the
// exact process instance. Only CONFIRMED_MALWARE is approvable.
// Containment: validates the token against the PINNED instance and the
// authority epoch, then terminates through the same reference (PID-reuse
// safe, no taskkill).
app.post("/api/containment/approve", async (req, res) => {
  try {
    const pid = Number(req.body?.pid);
    const operatorCredential = String(req.body?.operatorCredential ?? "");
    if (!Number.isInteger(pid) || pid <= 0) {
      return res.status(400).json({ error: "pid is required (positive integer)" });
    }
    if (!operatorCredential) {
      return res.status(400).json({ error: "operatorCredential is required — containment approval must be the operator's decision (enrolled via set-containment-credential on the recovery pipe)" });
    }
    if (operatorCredential.length > 200) {
      return res.status(400).json({ error: "operatorCredential is malformed" });
    }
    const issuance = await threatContainment.issueApproval(pid, operatorCredential);
    res.json({
      approved: issuance.outcome === "APPROVAL_ISSUED",
      outcome: issuance.outcome,
      reason: issuance.reason,
      token: issuance.token?.token,
      expiresAt: issuance.token?.expiresAt,
      classification: issuance.classification,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "containment approval failed" });
  }
});

app.post("/api/containment/contain", async (req, res) => {
  try {
    const pid = Number(req.body?.pid);
    const approvalToken = String(req.body?.approvalToken ?? "");
    if (!Number.isInteger(pid) || pid <= 0) {
      return res.status(400).json({ error: "pid is required (positive integer)" });
    }
    if (!approvalToken) {
      return res.status(400).json({ error: "approvalToken is required (issued by /api/containment/approve)" });
    }
    const result = await threatContainment.contain({ pid, approvalToken });
    res.json({ outcome: result.outcome, reason: result.reason, targetPid: result.targetPid, targetName: result.targetName });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "containment failed" });
  }
});

// ---- Phase E: read-only intelligence routes (NO control surface) ----
// Both routes are GET-only, read-only, and rate-limited; they cannot mutate
// any state and cannot invoke any control. `recheckDefender=1` triggers the
// rate-limited (5 min) explicit Defender availability check — never polled.
app.get("/api/security/situation", (req, res) => {
  try {
    if (req.query.recheckDefender === "1") securitySituation.recheckDefender();
    res.json(securitySituation.getSituation());
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "security situation failed" });
  }
});
app.get("/api/security/assessments", (_req, res) => {
  try {
    res.json({ assessments: assessmentEngine.assess(securityIntel) });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "security assessments failed" });
  }
});

// ---- Phase F: incident status (read-only) + coordinated containment ----
// GET /api/security/incidents is read-only status. POST /api/incidents/contain
// executes containment THROUGH Phase D for an existing incident: the
// orchestrator re-evaluates eligibility against live state (evidence,
// E-stop, credential epoch, identity) immediately before calling Phase D,
// whose credential verification, pinning, and E-stop checks remain the
// authority. Every refusal is recorded on the incident and audited.
app.get("/api/security/incidents", (req, res) => {
  try {
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (id) {
      const inc = incidentStore.get(id);
      if (!inc) return res.status(404).json({ error: "incident not found" });
      return res.json({ incident: inc, stopKind: stopKind(), credentialEnrolled: containmentApprovalCredentialSet(), authorityEpoch: containmentApprovalEpoch() });
    }
    res.json({
      activeCount: incidentStore.activeCount(),
      archivedCount: incidentStore.archivedCount(),
      stopKind: stopKind(),
      credentialEnrolled: containmentApprovalCredentialSet(),
      incidents: incidentStore.all().map((inc) => ({
        id: inc.id,
        state: inc.state,
        severity: inc.severity,
        confidence: inc.confidence,
        subject: inc.subject,
        evidenceCount: inc.evidence.length,
        confirmedEvidence: inc.evidence.some((e) => e.verification === "confirmed-by-source"),
        assessmentCount: inc.assessments.length,
        responseCount: inc.responses.length,
        pendingOperatorDecision: inc.pendingOperatorDecision,
        containmentOutcome: inc.containmentOutcome,
        finalOutcome: inc.finalOutcome,
        lastTransition: inc.transitions[inc.transitions.length - 1] ?? null,
        createdAt: inc.createdAt,
        updatedAt: inc.updatedAt,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "incident status failed" });
  }
});
app.post("/api/incidents/contain", async (req, res) => {
  try {
    const incidentId = String(req.body?.incidentId ?? "");
    const operatorCredential = String(req.body?.operatorCredential ?? "");
    if (!incidentId) return res.status(400).json({ error: "incidentId is required" });
    if (!operatorCredential) return res.status(400).json({ error: "operatorCredential is required - containment is the operator's decision (Phase D credential verification)" });
    if (operatorCredential.length > 200) return res.status(400).json({ error: "operatorCredential is malformed" });
    const response = await incidentOrchestrator.respondContain(incidentId, operatorCredential);
    res.json({ action: response.action, eligibility: response.eligibility, result: response.result ?? null, attempted: response.attempted, reason: response.reason });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "incident containment failed" });
  }
});

// ---- E5 M3: rollback planning + operator-bound challenge lifecycle ----
// The model may REQUEST a plan; approval happens ONLY through the Krisha UI
// affordance (operator click → /api/rollback/approve). Plans and challenge
// bindings live server-side; clients pass opaque ids only.
function rollbackResult(res: import("express").Response, fn: () => unknown): void {
  try {
    res.json({ success: true, result: fn() });
  } catch (err) {
    res.json({ success: false, error: String((err as Error)?.message || err) });
  }
}
app.get("/api/rollback/pending", (req, res) => rollbackResult(res, () => rollback.pendingChallenges()));
app.post("/api/rollback/plan", (req, res) => rollbackResult(res, () => rollback.planRollback(String(req.body?.opId ?? ""))));
app.post("/api/rollback/approve", (req, res) => rollbackResult(res, () => rollback.approveChallenge(String(req.body?.challengeId ?? ""))));
app.post("/api/rollback/decline", (req, res) => rollbackResult(res, () => rollback.declineChallenge(String(req.body?.challengeId ?? ""))));
app.post("/api/rollback/execute", (req, res) => rollbackResult(res, () => rollback.executeRollback({
  opId: String(req.body?.opId ?? ""),
  planHash: String(req.body?.planHash ?? ""),
  challengeId: String(req.body?.challengeId ?? ""),
})));

// ---- E5 M3: E7 quarantine (operator release by exact path declaration) ----
app.get("/api/quarantine/list", (req, res) => rollbackResult(res, () => quarantine.listQuarantine()));
// E5 H1/H2 — explicit, audited integrity scan. Read-only: it authorizes nothing,
// releases nothing, deletes nothing — orphaned artifacts stay locked and are
// reported for operator review. H2: bounded pagination with digest-bound
// continuation (an artifact-set change fails the continuation closed).
app.post("/api/quarantine/scan", (req, res) => rollbackResult(res, () => quarantine.auditedQuarantineScan({
  continuation: req.body?.continuation && typeof req.body.continuation === 'object'
    ? { after: req.body.continuation.after === undefined ? undefined : String(req.body.continuation.after), digest: req.body.continuation.digest === undefined ? undefined : String(req.body.continuation.digest) }
    : undefined,
  limit: Number.isFinite(Number(req.body?.limit)) && Number(req.body?.limit) > 0 ? Number(req.body.limit) : undefined,
})));
app.post("/api/quarantine/release", (req, res) => rollbackResult(res, () => {
  const declared = Array.isArray(req.body?.declaredPaths) ? req.body.declaredPaths.map((p: unknown) => String(p)) : [];
  return quarantine.releaseQuarantine(declared);
}));

app.post('/api/app/discover', (req, res) =>
  fsResult(res, () => sys.appDiscover(req.body?.force === true).then((apps) => sys.appSearch(apps, String(req.body?.query ?? ''))))
);
app.post('/api/app/launch', (req, res) =>
  fsResult(res, async () => {
    try {
      return req.body?.path
        ? await sys.appLaunchByPath(String(req.body.path), req.body?.approvalToken)
        : await sys.appLaunchByName(String(req.body?.name ?? ''), req.body?.approvalToken, typeof req.body?.protocol === 'string' ? req.body.protocol : undefined);
    } catch (err: any) {
      // Phase C: the execution gate asked for an operator decision. Raise it on
      // the unified approval surface so it can be answered from the Windows
      // toast as well as the browser — and so confidence-gated autonomy can
      // act on it if the operator is away and this action type is proven safe.
      const decision = err?.execGateDecision;
      if (decision?.decision === 'REQUIRE_USER_APPROVAL') {
        const identity = decision.fileIdentity ?? {};
        const request = await approvalRegistry.raise({
          actionType: 'exec_launch',
          title: 'Launch needs your approval',
          detail: String(decision.reason ?? 'the execution gate requires approval').slice(0, 400),
          risk: decision.classification === 'HIGH_CONFIDENCE_THREAT' ? 'high' : 'medium',
          backend: {
            kind: 'execgate',
            ref: String(identity.path ?? ''),
            extra: {
              path: identity.path,
              mtimeMs: identity.mtimeMs,
              size: identity.size,
              classification: decision.classification,
            },
          },
        });
        const view = approvalRegistry.list().find((r) => r.id === request.id);
        if (request.state === 'auto_approved' && view?.issuedToken) {
          // The confidence gate approved it while the operator was away.
          return sys.appLaunchByPath(String(identity.path), view.issuedToken);
        }
        const error = new Error(
          `Execution gate: approval required — request ${request.id} (answer it in Krisha or the Action Center toast)`
        );
        (error as any).approvalRequestId = request.id;
        (error as any).approvalRequest = view;
        throw error;
      }
      throw err;
    }
  })
);
app.post('/api/app/status', (req, res) => fsResult(res, () => sys.appStatus(String(req.body?.name ?? ''))));
app.post('/api/app/close', (req, res) => fsResult(res, () => sys.appClose(Number(req.body?.pid), req.body?.force === true)));
app.post('/api/app/focus', (req, res) => fsResult(res, () => sys.appFocus(Number(req.body?.pid))));

// ---- Initiation Subsystem Routes (Scheduler, Event Triggers, Boot Resume) ----
// Nightly Reflection: return a bounded, metadata-only digest from the verified
// audit tail. Raw audit entries never leave the server and the browser decides
// whether/how to consolidate the fixed correction guidance into local memory.
app.get('/api/reflection/nightly', (req, res) => {
  const verified = verifyAuditChain();
  const segment = readLastVerifiedAuditSegment(10_000);
  if (!segment.available || !segment.coversTail) {
    return res.status(503).json({ verified: false, reason: segment.reason ?? 'audit tail is not verifiable' });
  }
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const rules: Record<string, string> = {
    e5_rollback_refused: 'When a rollback is refused, inspect and refresh its plan before attempting it again.',
    e5_quarantine_release_refused: 'When a quarantine release is refused, keep the item quarantined and review the refusal before retrying.',
    approval_denied: 'When an approval is denied, do not repeat the action without a new operator decision.',
    e5_stop_blocked: 'When safety controls block an action, resolve the control state before retrying.',
    approval_auto_failed: 'When unattended approval fails, return the action to the operator instead of retrying automatically.',
  };
  const counts = new Map<string, number>();
  for (const record of segment.records) {
    if (typeof record.at !== 'number' || record.at < since.getTime()) continue;
    const kind = typeof record.kind === 'string' ? record.kind : '';
    if (rules[kind]) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  res.json({
    verified: true,
    wholeFileVerified: verified.ok,
    entries: segment.records.filter((r) => typeof r.at === 'number' && r.at >= since.getTime()).length,
    corrections: Array.from(counts.entries()).slice(0, 5).map(([kind, count]) => ({ kind, count, text: rules[kind] })),
  });
});
app.get('/api/initiation/status', (req, res) => {
  res.json(initiationManager.getStatus());
});

app.get('/api/initiation/missions', (req, res) => {
  res.json({ missions: initiationManager.scheduler.getMissions() });
});

app.post('/api/initiation/missions', (req, res) => {
  try {
    const { id, name, description, kind, trigger, actionPayload, promptInstruction, action } = req.body;
    if (!id || !name || !trigger) {
      return res.status(400).json({ error: 'id, name, and trigger are required' });
    }
    const created = initiationManager.scheduler.addMission({
      id: String(id),
      name: String(name),
      description: String(description || ''),
      kind: kind || 'custom_task',
      trigger,
      actionPayload,
      promptInstruction,
      action,
      enabled: req.body.enabled !== false,
    });
    res.json({ success: true, mission: created });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to add mission' });
  }
});

app.post('/api/initiation/missions/:id/toggle', (req, res) => {
  const enabled = initiationManager.scheduler.toggleMission(req.params.id, req.body?.enabled);
  res.json({ success: true, id: req.params.id, enabled });
});

app.post('/api/initiation/missions/:id/trigger', async (req, res) => {
  const result = await initiationManager.scheduler.triggerNow(req.params.id);
  if (!result) return res.status(404).json({ error: 'Mission not found' });
  res.json({ success: result.success, result });
});

app.get('/api/initiation/rules', (req, res) => {
  res.json({ rules: initiationManager.triggers.getRules() });
});

app.post('/api/initiation/rules', (req, res) => {
  try {
    const { id, name, description, source, eventType, filter, action, cooldownMs } = req.body;
    if (!id || !name || !source || !eventType || !action) {
      return res.status(400).json({ error: 'id, name, source, eventType, and action are required' });
    }
    const created = initiationManager.triggers.addRule({
      id: String(id),
      name: String(name),
      description: String(description || ''),
      source,
      eventType,
      filter,
      action,
      cooldownMs: Number(cooldownMs) || 60_000,
      enabled: req.body.enabled !== false,
    });
    res.json({ success: true, rule: created });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to add rule' });
  }
});

app.post('/api/initiation/rules/:id/toggle', (req, res) => {
  const enabled = initiationManager.triggers.toggleRule(req.params.id, req.body?.enabled);
  res.json({ success: true, id: req.params.id, enabled });
});

app.get('/api/initiation/boot-resume', (req, res) => {
  res.json(initiationManager.bootResume.inspectBootGoals());
});

app.post('/api/initiation/sync-goals', (req, res) => {
  try {
    const goals = Array.isArray(req.body?.goals) ? req.body.goals : [];
    initiationManager.bootResume.saveDurableGoals(goals);
    res.json({ success: true, count: goals.length });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to sync goals' });
  }
});

app.post('/api/initiation/boot-resume/:id/resume', (req, res) => {
  const resumed = initiationManager.bootResume.resumeGoal(req.params.id);
  if (!resumed) return res.status(404).json({ error: 'Goal not found' });
  res.json({ success: true, goal: resumed });
});

app.get('/api/initiation/events', (req, res) => {
  res.json({ events: initiationManager.getRecentEvents() });
});

// ---- Initiation delivery channel (server -> browser executor) ----
// The trigger engine decides WHEN/WHAT; the browser decides WHETHER/HOW.
// This SSE stream is the handoff: a queued initiation is pushed the moment
// it exists, and the browser reports the outcome back through /ack.

app.get('/api/initiation/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const clientId = String(req.query.clientId || `client_${Date.now().toString(36)}`);
  const write = (chunk: string) => {
    res.write(chunk);
  };

  // Tell the client it is connected, then hand over the backlog — a mission
  // that fired while the browser was closed must not be lost.
  write(`event: ready\ndata: ${JSON.stringify({ clientId })}\n\n`);
  try {
    // Leased, not merely listed: a second client must not run the same work.
    for (const lease of initiationManager.queue.claim(clientId, 25)) {
      write(`event: initiation\ndata: ${JSON.stringify(lease.record)}\n\n`);
    }
  } catch {
    // a backlog read failure must not kill the stream
  }

  const client = { write, close: () => { try { res.end(); } catch { /* already closed */ } } };
  initiationClients.add(client);

  // Keep the connection warm without spamming the client.
  const keepAlive = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      clearInterval(keepAlive);
    }
  }, 25_000);
  (keepAlive as any)?.unref?.();

  const cleanup = () => {
    clearInterval(keepAlive);
    initiationClients.delete(client);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
});

// Fallback for clients that cannot hold an SSE connection open: claim and
// return whatever is waiting. The lease mechanism means a dropped connection
// never loses the work.
app.get('/api/initiation/pending', (req, res) => {
  try {
    const clientId = String(req.query.clientId || `client_${Date.now().toString(36)}`);
    const limit = Math.min(25, Math.max(1, Number(req.query.limit) || 10));
    const leases = initiationManager.queue.claim(clientId, limit);
    res.json({ leases });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to claim pending initiations' });
  }
});

// The executor's report for one record.
app.post('/api/initiation/ack', (req, res) => {
  try {
    const { id, success, summary } = req.body ?? {};
    if (!id) return res.status(400).json({ error: 'id is required' });
    const applied = initiationManager.acknowledge(String(id), success === true, summary ? String(summary) : undefined);
    res.json({ success: applied });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to acknowledge initiation' });
  }
});

// The executor could not deliver the record RIGHT NOW (quiet hours, the user
// is busy). Deferring keeps the work — dropping it would silently lose a
// mission. The record returns to the queue and is handed out again later.
app.post('/api/initiation/defer', (req, res) => {
  try {
    const { id, delayMs } = req.body ?? {};
    if (!id) return res.status(400).json({ error: 'id is required' });
    const delay = Math.min(6 * 60 * 60 * 1000, Math.max(0, Number(delayMs) || 0));
    const deferred = initiationManager.queue.defer(String(id), delay);
    res.json({ success: deferred, deferred });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to defer initiation' });
  }
});

// The Windows layer reports that the clipboard changed. Deliberately
// content-free — the Win32 clipboard sequence counter needs no clipboard read,
// so Krisha learns that something was copied without ever reading what.
app.post('/api/initiation/clipboard', (req, res) => {
  try {
    initiationManager.triggers.handleClipboardChanged();
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to signal clipboard change' });
  }
});

// The browser knows which project roots the user approved (approval lives in
// the browser's ProjectEngine); the server is the only side that can watch
// the filesystem. This hands the approved roots over — nothing else is ever
// watched.
app.post('/api/initiation/watch', (req, res) => {
  try {
    const directories = Array.isArray(req.body?.directories)
      ? req.body.directories.filter((d: unknown): d is string => typeof d === 'string' && d.length > 0)
      : [];
    initiationManager.triggers.startFileWatcher(directories);
    res.json({ success: true, watching: initiationManager.triggers.getWatchedDirectories() });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to set watched directories' });
  }
});

// Diagnostics: the full queue, newest first.
app.get('/api/initiation/queue', (req, res) => {
  res.json({ records: initiationManager.queue.list(), stats: initiationManager.queue.stats() });
});

// ---- LPV — Local Private Vault (post-roadmap capability) ----
// Encrypted local credential storage, retention policy, controlled retrieval.
// Security design lives in lpvCore.ts / lpvDpapi.ts; integration seams for
// SPF, Action Transparency and the agent architecture are documented in
// ARCHITECTURE.md §32. The import resolves the vault boot state
// synchronously (no async work at module load — same convention as E5).
import * as lpv from './lpvCore';

function lpvErrorKindOf(err: unknown): string {
  if (err instanceof lpv.LpvError) return err.kind;
  return 'internal_error';
}

function lpvResult(res: import("express").Response, fn: () => unknown): void {
  try {
    res.json({ success: true, result: fn() });
  } catch (err) {
    res.json({ success: false, errorKind: lpvErrorKindOf(err), error: String((err as Error)?.message || err).slice(0, 300) });
  }
}

function lpvResultAsync(res: import("express").Response, fn: () => Promise<unknown>): void {
  fn()
    .then((result) => res.json({ success: true, result }))
    .catch((err) => res.json({ success: false, errorKind: lpvErrorKindOf(err), error: String((err as Error)?.message || err).slice(0, 300) }));
}

function lpvRequester(req: any): string {
  return String(req.body?.requester ?? 'ui').slice(0, 60);
}

// Status is ungated (like /api/health) — it carries state flags only, never
// secrets or entry metadata.
app.get("/api/vault/status", (req, res) => {
  res.json({ success: true, result: lpv.getVaultStatus() });
});

app.get("/api/vault/entries", (req, res) => lpvResult(res, () => lpv.listEntries()));
app.post("/api/vault/init", (req, res) => lpvResultAsync(res, () => lpv.initializeVault()));
app.post("/api/vault/unlock", (req, res) => lpvResultAsync(res, () => lpv.unlockVault()));
app.post("/api/vault/lock", (req, res) => lpvResult(res, () => lpv.lockVault(String(req.body?.reason ?? 'operator requested'))));
app.post("/api/vault/restore", (req, res) => lpvResultAsync(res, () => lpv.restoreFromBackup()));

app.post("/api/vault/entry", (req, res) =>
  lpvResult(res, () =>
    lpv.addEntry(
      {
        categoryKey: String(req.body?.categoryKey ?? ''),
        title: String(req.body?.title ?? ''),
        username: req.body?.username === undefined ? undefined : String(req.body.username),
        password: String(req.body?.password ?? ''),
        notes: req.body?.notes === undefined ? undefined : String(req.body.notes),
        url: req.body?.url === undefined || req.body?.url === '' ? undefined : String(req.body.url),
      },
      req.body?.approval && typeof req.body.approval === 'object' ? req.body.approval : { kind: 'user-direct' },
      lpvRequester(req)
    )
  )
);

app.post("/api/vault/entry/update", (req, res) =>
  lpvResult(res, () =>
    lpv.updateEntry(
      String(req.body?.id ?? ''),
      {
        categoryKey: req.body?.categoryKey === undefined ? undefined : String(req.body.categoryKey),
        title: req.body?.title === undefined ? undefined : String(req.body.title),
        username: req.body?.username === undefined ? undefined : String(req.body.username),
        password: req.body?.password === undefined ? undefined : String(req.body.password),
        notes: req.body?.notes === undefined ? undefined : String(req.body.notes),
        url: req.body?.url === undefined ? undefined : String(req.body.url),
      },
      req.body?.approval && typeof req.body.approval === 'object' ? req.body.approval : { kind: 'user-direct' },
      lpvRequester(req)
    )
  )
);

app.post("/api/vault/entry/delete", (req, res) =>
  lpvResult(res, () => lpv.deleteEntry(String(req.body?.id ?? ''), lpvRequester(req)))
);

app.get("/api/vault/policy", (req, res) => lpvResult(res, () => lpv.getPolicy()));
app.post("/api/vault/policy/update", (req, res) =>
  lpvResult(res, () =>
    lpv.setPolicy(
      {
        autoSaveEnabled: req.body?.autoSaveEnabled === undefined ? undefined : req.body.autoSaveEnabled === true,
        autoSaveCategories: req.body?.autoSaveCategories,
        autoLockMs: req.body?.autoLockMs === undefined ? undefined : Number(req.body.autoLockMs),
      },
      lpvRequester(req)
    )
  )
);

app.get("/api/vault/history", (req, res) =>
  lpvResult(res, () => lpv.getHistory(Number.isFinite(Number(req.query?.limit)) ? Number(req.query.limit) : undefined))
);

app.post("/api/vault/fill", (req, res) =>
  lpvResultAsync(res, () =>
    lpv.fillEntry(
      {
        grantId: String(req.body?.grantId ?? ''),
        fields: Array.isArray(req.body?.fields) ? req.body.fields : [],
      },
      lpvRequester(req)
    )
  )
);

app.post("/api/vault/fill/request", (req, res) =>
  lpvResult(res, () => lpv.requestUiFill(String(req.body?.entryId ?? '')))
);

app.post("/api/vault/challenge", (req, res) =>
  lpvResult(res, () =>
    lpv.createChallenge(
      req.body?.purpose === 'save' ? 'save' : 'fill',
      {
        entryId: req.body?.entryId === undefined ? undefined : String(req.body.entryId),
        origin: req.body?.origin === undefined ? undefined : String(req.body.origin),
        entryDraft: req.body?.entryDraft && typeof req.body.entryDraft === 'object'
          ? {
              categoryKey: String(req.body.entryDraft.categoryKey ?? ''),
              title: String(req.body.entryDraft.title ?? ''),
              url: req.body.entryDraft.url === undefined ? undefined : String(req.body.entryDraft.url),
            }
          : undefined,
        // Fill challenges carry the exact operation approval will execute
        // (field specs only — no values; values come from the vault).
        fields: Array.isArray(req.body?.fields) ? req.body.fields : undefined,
      },
      lpvRequester(req)
    )
  )
);

app.get("/api/vault/approvals/pending", (req, res) => lpvResult(res, () => lpv.listPendingChallenges()));
app.post("/api/vault/approvals/approve", (req, res) =>
  lpvResultAsync(res, () =>
    lpv.approveChallenge(String(req.body?.challengeId ?? ''), req.body?.decisionToken)
  )
);
app.post("/api/vault/approvals/decline", (req, res) =>
  lpvResult(res, () => lpv.declineChallenge(String(req.body?.challengeId ?? ''), req.body?.decisionToken))
);
app.post("/api/vault/challenge/status", (req, res) =>
  lpvResult(res, () => lpv.getChallengeStatus(String(req.body?.challengeId ?? '')))
);

// ---------------------------------------------------------------------------
// Approval Surface — one set of operator decisions, presented wherever the
// operator actually is (browser window OR Windows Action Center toast).
//
// The server decides WHEN to ask (the confidence-gated policy) and carries
// the decision to the subsystem that owns it. It never replaces that
// subsystem's authority.
//
// See src/agent/approval/ for the full design; ARCHITECTURE.md §41 for the
// architecture record.
// ---------------------------------------------------------------------------

const APPROVAL_STATE_DIR = path.join(process.cwd(), ".krisha", "approval");
const APPROVAL_POLICY_FILE = path.join(APPROVAL_STATE_DIR, "policy.json");

/** The operator's policy — persisted so it survives a restart. */
let approvalPolicy: ApprovalPolicy = { ...DEFAULT_APPROVAL_POLICY };
try {
  if (fs.existsSync(APPROVAL_POLICY_FILE)) {
    approvalPolicy = sanitizePolicy(JSON.parse(fs.readFileSync(APPROVAL_POLICY_FILE, "utf8")));
  }
} catch (err) {
  console.warn("[approval] could not read the stored policy — using defaults:", err);
}
function saveApprovalPolicy(): void {
  try {
    if (!fs.existsSync(APPROVAL_STATE_DIR)) fs.mkdirSync(APPROVAL_STATE_DIR, { recursive: true });
    fs.writeFileSync(APPROVAL_POLICY_FILE, JSON.stringify(approvalPolicy, null, 2), "utf8");
  } catch (err) {
    console.warn("[approval] could not persist the policy:", err);
  }
}

const approvalTrust = new TrustGate({
  // The E5 audit chain is the ONLY learning source. The gate reads the LAST
  // contiguous hash-verified segment (the recent evidence) and verifies that
  // it reaches the end of the file — so stale evidence is never presented as
  // current, and a tampered tail teaches nothing. The whole-file verdict is
  // reported alongside it for the operator.
  readAudit: () => {
    const segment = readLastVerifiedAuditSegment(5000);
    return {
      entries: segment.records,
      available: segment.available,
      ...(segment.reason ? { reason: segment.reason } : {}),
      coversTail: segment.coversTail,
      length: segment.length,
    };
  },
  verifyChain: () => verifyAuditChain(),
  storagePath: path.join(APPROVAL_STATE_DIR, "trust_state.json"),
  audit: (event) => auditAndIngest(event, "approval-trust"),
});

const approvalPresence = new PresenceTracker();

const approvalRegistry = new ApprovalRegistry({
  trust: approvalTrust,
  presence: approvalPresence,
  getPolicy: () => approvalPolicy,
  audit: (event) => auditAndIngest(event, "approval-surface"),
  backends: {
    // E5 rollback core — the owning subsystem decides; the registry only
    // carries the operator's answer to it.
    rollback: {
      approve: (request) => {
        try {
          rollback.approveChallenge(request.backend.ref);
          return { ok: true, reason: 'rollback challenge approved' };
        } catch (err: any) {
          return { ok: false, reason: err?.message || String(err) };
        }
      },
      decline: (request) => {
        try {
          rollback.declineChallenge(request.backend.ref);
          return { ok: true, reason: 'rollback challenge declined' };
        } catch (err: any) {
          return { ok: false, reason: err?.message || String(err) };
        }
      },
    },
    // LPV vault — the one-time decision token stays inside the vault. It is
    // fetched here from the operator-facing pending listing, which is the
    // only place it is ever released.
    lpv: {
      approve: async (request) => {
        const pending = lpv.listPendingChallenges();
        const match = pending.find((c) => c.challengeId === request.backend.ref);
        if (!match) return { ok: false, reason: 'the vault challenge is no longer pending' };
        const result = await lpv.approveChallenge(match.challengeId, match.decisionToken);
        return {
          ok: result.approved === true,
          reason: result.approved ? 'vault challenge approved' : 'vault approval refused',
          ...(result.fill ? { result: { fill: result.fill } } : {}),
        };
      },
      decline: (request) => {
        const pending = lpv.listPendingChallenges();
        const match = pending.find((c) => c.challengeId === request.backend.ref);
        if (!match) return { ok: false, reason: 'the vault challenge is no longer pending' };
        const result = lpv.declineChallenge(match.challengeId, match.decisionToken);
        return { ok: result.declined === true, reason: 'vault challenge declined' };
      },
    },
    // Phase C execution gate — the approval mints a single-use launch token
    // bound to the exact file identity that was assessed.
    execgate: {
      approve: (request) => {
        const extra = request.backend.extra ?? {};
        const path = String(extra.path ?? request.backend.ref);
        const mtimeMs = Number(extra.mtimeMs ?? 0);
        const size = Number(extra.size ?? 0);
        const classification = String(extra.classification ?? 'SUSPICIOUS');
        const token = executionGate.issueApproval(path, { path, mtimeMs, size }, classification);
        if (!token) {
          return { ok: false, reason: 'the execution gate refused to issue an approval for this classification' };
        }
        return { ok: true, reason: 'launch approval issued', issuedToken: token.token };
      },
      decline: () => ({ ok: true, reason: 'launch declined — no approval was issued' }),
    },
    // E5 quarantine — releasing a quarantined file.
    quarantine: {
      approve: (request) => {
        const extra = request.backend.extra ?? {};
        const paths = Array.isArray(extra.paths) ? (extra.paths as string[]) : [];
        const result = quarantine.releaseQuarantine(paths);
        const released = Array.isArray(result?.released) ? result.released : [];
        const refused = Array.isArray(result?.refused) ? result.refused : [];
        return {
          ok: released.length > 0,
          reason: released.length > 0 ? `released ${released.length} item(s)` : 'the release was refused',
          result: { released, refused },
        };
      },
      decline: () => ({ ok: true, reason: 'quarantine release declined' }),
    },
    // Phase D containment — deliberately NOT decidable from this surface.
    // Its authority is the operator CREDENTIAL, not a click; a toast cannot
    // carry a secret. The request is surfaced so the operator KNOWS, but the
    // decision still has to be made in Krisha (or the recovery CLI) with the
    // enrolled credential.
    containment: {
      approve: () => ({
        ok: false,
        reason: 'containment requires the operator credential — approve it in Krisha or the recovery CLI',
      }),
      decline: () => ({ ok: true, reason: 'containment declined' }),
    },
  },
});

// The rollback core and the LPV vault now tell the registry when they raise
// a challenge, so the unified surface sees them the moment they exist.
rollback.setRollbackChallengeHook((info) => {
  void approvalRegistry.raise({
    actionType: 'rollback',
    title: 'Rollback needs your approval',
    detail: `Restore ${info.affectedPaths.length} file(s) from the ${info.opKind} journal.`,
    risk: 'medium',
    backend: {
      kind: 'rollback',
      ref: info.challengeId,
      extra: { opId: info.opId, planHash: info.planHash, opKind: info.opKind },
    },
    ttlMs: Math.max(1000, info.expiresAt - Date.now()),
  });
});

lpv.setLpvChallengeHook((info) => {
  void approvalRegistry.raise({
    actionType: 'vault_retrieval',
    title: 'Vault access needs your approval',
    detail: info.purpose === 'fill'
      ? `Fill a stored credential${info.entryTitle ? ` (${info.entryTitle})` : ''}.`
      : `Retrieve a stored credential${info.entryTitle ? ` (${info.entryTitle})` : ''}.`,
    risk: 'high',
    backend: { kind: 'lpv', ref: info.challengeId },
    ttlMs: Math.max(1000, info.expiresAt - Date.now()),
  });
});

// ---- Approval Surface routes ----
// The pending listing is the operator-facing surface: it is the ONLY place
// the decision capability is released, exactly like the LPV vault's pending
// listing releases its one-time decision token.

app.get('/api/approvals/pending', (req, res) => {
  res.json({ requests: approvalRegistry.pending(), presence: approvalRegistry.presenceState() });
});

app.post('/api/approvals/surfaced', (req, res) => {
  try {
    const id = String(req.body?.id ?? '');
    const via = req.body?.via === 'toast' ? 'toast' : 'browser';
    const ok = approvalRegistry.markSurfaced(id, via);
    res.json({ success: ok });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to record the surface' });
  }
});

app.post('/api/approvals/decide', async (req, res) => {
  try {
    const id = String(req.body?.id ?? '');
    const decision = req.body?.decision === 'approve' ? 'approve' : req.body?.decision === 'deny' ? 'deny' : '';
    if (!id || !decision) return res.status(400).json({ error: 'id and decision are required' });
    const via = req.body?.via === 'toast' ? 'toast' : 'browser';
    const capability = typeof req.body?.capability === 'string' ? req.body.capability : undefined;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 300) : undefined;
    const result = await approvalRegistry.decide(id, decision, via, capability, reason);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to record the decision' });
  }
});

app.get('/api/approvals/trust', (req, res) => {
  const trust = approvalRegistry.trustState();
  res.json({
    ...trust,
    policy: approvalRegistry.policy(),
    presence: approvalRegistry.presenceState(),
    autoApprovable: [...AUTO_APPROVABLE_ACTION_TYPES],
  });
});
app.post('/api/approvals/policy', (req, res) => {
  try {
    approvalPolicy = sanitizePolicy({ ...approvalPolicy, ...(req.body ?? {}) });
    saveApprovalPolicy();
    res.json({ success: true, policy: approvalPolicy });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to save the policy' });
  }
});

// Presence: the browser reports in while the operator is actually there.
// This is what separates "online — ask" from "offline — act alone if trusted".
app.post('/api/approvals/presence', (req, res) => {
  try {
    const present = req.body?.present !== false;
    if (present) approvalPresence.markPresent();
    else approvalPresence.markAbsent();
    res.json({ success: true, presence: approvalRegistry.presenceState() });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to update presence' });
  }
});

// A containment decision that needs the operator is surfaced (so the operator
// knows), but it is never decided by this surface — its authority is the
// operator credential.
app.get('/api/approvals/containment-pending', (req, res) => {
  try {
    const incidents = incidentStore.all();
    const pending = (Array.isArray(incidents) ? incidents : [])
      .filter((i: any) => i?.state === 'AWAITING_OPERATOR' || typeof i?.pendingOperatorDecision === 'string')
      .map((i: any) => ({
        id: i.id,
        title: 'Containment needs your decision',
        detail: i.pendingOperatorDecision ?? 'operator decision required',
        severity: i.severity,
      }));
    res.json({ pending, requiresCredential: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to list pending containment decisions' });
  }
});

// Vite middleware & Static serving
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const httpServer = app.listen(PORT, BIND, () => {
    console.log(`Krisha server running on http://${BIND}:${PORT}${BIND === "127.0.0.1" ? " (loopback — E5 D1)" : " (LAN-EXPOSED — explicit KRISHA_BIND override)"}`);
  });
  // Step 1 Background Runtime — single-instance guard: a second Krix server
  // start must never spawn a duplicate runtime. The port bind is the
  // authoritative lock; a bind failure reports the running instance and
  // exits THIS process cleanly (no crash stack, exit code 0 for scripts).
  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.log(`[runtime] Krisha server is already running on ${BIND}:${PORT} — keeping the existing instance (this duplicate start exits cleanly).`);
      process.exit(0);
      return;
    }
    console.error(`[runtime] server listen error: ${err.code ?? err.message}`);
    process.exit(1);
  });
  // E5 H4 — server-owned runtime integrity monitoring: bounded, unref'd
  // periodic evaluation (default 60 s, KRISHA_INTEGRITY_INTERVAL_MS to
  // configure) + read-only status endpoint below. Monitoring reports; it
  // never repairs, releases, or changes the stop state.
  startIntegrityMonitor();
  console.log(`[E5] integrity monitoring active (interval ${configuredIntervalMs()} ms)`);
  // Phase A — independent process monitoring: event-driven WMI subscriptions
  // owned by this process (temporary, session-scoped, no admin, no permanent
  // consumers). Visibility only; lifecycle/health events land in the E5
  // audit chain as metadata. Clean disposal on exit; the worker also self-
  // exits when this process dies (parent-PID probe each idle cycle).
  process.on("exit", () => {
    processMonitor.stop();
    malwareEngine.stop();
    clearInterval(securityStateSampler); // Phase E sampler — graceful shutdown
  });
  void processMonitor.start().then((health) => {
    console.log(`[KPM] process monitor active (health ${health})`);
    // Phase B: detection engine consumes Phase A telemetry (started after the
    // monitor so no creation event is missed before the subscription).
    malwareEngine.start();
  });
  // E5 M1d — bounded request lifetimes.
  httpServer.requestTimeout = 60_000;
  httpServer.headersTimeout = 65_000;

  // Step 1 Background Runtime — graceful shutdown on termination signals
  // (Ctrl+C in the console, service stop, container stop). Windows sleep is
  // NOT a signal: the process simply freezes and resumes unchanged. The
  // sequence stops the HTTP listener, the PowerShell worker and the monitor
  // subscriptions deterministically (module: src/server/runtimeShutdown.ts).
  installGracefulShutdown({
    onStop: () => {
      try {
        httpServer.close();
      } catch {
        // best-effort; listeners are torn down by exit anyway
      }
      try {
        mouseWorker.kill();
      } catch {
        // worker may never have spawned
      }
      try {
        processMonitor.stop();
      } catch {
        // monitor owns its own lifecycle guards
      }
      try {
        malwareEngine.stop();
      } catch {
        // engine owns its own lifecycle guards
      }
      try {
        initiationManager.stop();
      } catch {
        // initiation owns its own lifecycle guards
      }
    },
  });
}

startServer();

