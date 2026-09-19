/**
 * Multimodal reasoner (Phase 14, spec §4–§7, §15) — deterministic
 * cross-modal reasoning over the bounded context.
 *
 * Properties:
 *  - source prioritization is deterministic (registry base priority adjusted
 *    by freshness and confidence — spec §5); old observations never outrank
 *    fresh evidence of the same aspect
 *  - conflicts are DETECTED and returned (never silently resolved)
 *  - confidence is evidence-weighted and reduced by conflicts/uncertainty;
 *    incomplete evidence yields explicit uncertainty + requiredVerification
 *    (never manufactured confidence)
 *  - an optional provider (spec §15) can enrich LOW-confidence answers using
 *    a redacted, bounded digest; the local deterministic result is baseline
 */
import type {
  ModalityConflict,
  ModalityObservation,
  ModalityType,
  MultimodalConclusion,
  MultimodalQuestion,
  MultimodalReasoningProvider,
  EvidenceRef,
} from './multimodalTypes';
import type { MultimodalContext } from './multimodalContext';
import { contentHash, tokenize } from './modalityNormalizer';

const CONFLICT_CONFIDENCE_PENALTY = 0.2;
const PROVIDER_TRIGGER_UNCERTAINTY = 0.65;

/** Deterministic question-intent classes (spec §4 examples). */
export function classifyQuestion(question: string): string {
  const q = question.toLowerCase();
  if (/(which|what)\s+(application|app|program|window)\b.*(active|open|focused|running)|current(ly)?\s+(active|open)\s+(app|application|window)/.test(q)) {
    return 'active_application';
  }
  if (/(find|locate|where is|click)\b.*(button|link|field|element|control)|login button|sign in button/.test(q)) {
    return 'find_element';
  }
  if (/^(verify|check|confirm|did)\b|\b(actually|really)\b/.test(q)) {
    return 'verify_state';
  }
  if (/(summar|read|section of)\b|\bdocument\b/.test(q)) {
    return 'summarize_document';
  }
  if (/(continue|resume|next step)\b.*\bworkflow\b|\bworkflow\b.*(continue|resume)/.test(q)) {
    return 'continue_workflow';
  }
  return 'general_question';
}

/** Extract the target term from element-finding questions. */
export function extractTarget(question: string): string {
  const m = question.match(/(?:the|a|an)\s+([a-z0-9][a-z0-9 _-]{1,30}?)\s*(?:button|link|field|element|control)/i);
  if (m) return m[1].trim();
  const login = question.match(/\b(login|sign in|log in)\b/i);
  if (login) return login[1];
  return '';
}

// ---------------------------------------------------------- conflict detect

/**
 * Detect cross-modal contradictions (spec §6). Deterministic rules over the
 * live context; each conflict names both sides and a resolution hint.
 */
export function detectConflicts(context: MultimodalContext, now: number = Date.now()): ModalityConflict[] {
  const conflicts: ModalityConflict[] = [];
  const browser = context.latest('browser_state', now);
  const screens = context.byType('ui_state', now).slice(0, 3);
  const apps = context.byType('application_state', now).slice(0, 4);

  // Rule 1: browser URL vs a different URL visible on screen.
  if (browser && browser.payload.type === 'browser_state' && browser.payload.url) {
    const urlHost = hostOf(browser.payload.url);
    for (const screen of screens) {
      if (screen.payload.type !== 'ui_state') continue;
      for (const text of screen.payload.summary.texts) {
        const screenUrl = text.match(/https?:\/\/[^\s]+/i)?.[0];
        if (screenUrl && hostOf(screenUrl) && urlHost && hostOf(screenUrl) !== urlHost) {
          conflicts.push({
            kind: 'browser_url_mismatch',
            description: `Browser reports "${browser.payload.url}" but the screen shows "${screenUrl}"`,
            sourceA: { observationId: browser.id, type: 'browser_state', aspect: 'url', quote: browser.payload.url, confidence: browser.confidence },
            sourceB: { observationId: screen.id, type: 'ui_state', aspect: 'visible url', quote: screenUrl, confidence: screen.confidence },
            resolution: 'requires_verification',
          });
          break;
        }
      }
    }
  }

  // Rule 2: application reported running but no window/text evidence (and vice versa).
  for (const app of apps) {
    if (app.payload.type !== 'application_state') continue;
    const name = app.payload.name.toLowerCase();
    const windowMentions = screens.some((s) => {
      if (s.payload.type !== 'ui_state') return false;
      const title = (s.payload.summary.activeWindowTitle ?? '').toLowerCase();
      const allText = s.payload.summary.texts.join(' ').toLowerCase();
      return title.includes(name) || allText.includes(name);
    });
    const firstScreen = screens.find((s) => s.payload.type === 'ui_state');
    if (app.payload.running === true && !windowMentions && firstScreen && firstScreen.payload.type === 'ui_state') {
      conflicts.push({
        kind: 'application_presence_mismatch',
        description: `Process "${app.payload.name}" is reported running but no visible window or text mentions it`,
        sourceA: { observationId: app.id, type: 'application_state', aspect: 'running', quote: String(app.payload.running), confidence: app.confidence },
        sourceB: { observationId: firstScreen.id, type: 'ui_state', aspect: 'visible windows', quote: firstScreen.payload.summary.activeWindowTitle ?? '', confidence: firstScreen.confidence },
        resolution: 'requires_verification',
      });
    }
  }

  // Rule 3: stale screen contradicting a fresh screen of the same aspect.
  const staleScreens = context.byType('ui_state', now).slice(0, 6);
  for (let i = 0; i < staleScreens.length; i++) {
    for (let j = i + 1; j < staleScreens.length; j++) {
      const a = staleScreens[i];
      const b = staleScreens[j];
      const aTitle = a.payload.type === 'ui_state' ? a.payload.summary.activeWindowTitle : undefined;
      const bTitle = b.payload.type === 'ui_state' ? b.payload.summary.activeWindowTitle : undefined;
      if (aTitle && bTitle && aTitle !== bTitle) {
        const older = a.timestamp <= b.timestamp ? a : b;
        const newer = a.timestamp <= b.timestamp ? b : a;
        if (now - older.timestamp > 60_000) {
          conflicts.push({
            kind: 'stale_state_contradiction',
            description: `Old screen observation ("${aTitle}") contradicts a fresher one ("${bTitle}")`,
            sourceA: { observationId: older.id, type: 'ui_state', aspect: 'active window', quote: aTitle, confidence: older.confidence },
            sourceB: { observationId: newer.id, type: 'ui_state', aspect: 'active window', quote: bTitle, confidence: newer.confidence },
            resolution: 'prefer_B',
          });
        }
      }
    }
  }

  // Rule 4: text instruction mentioning one URL/target while browser evidence shows another.
  const texts = context.byType('text', now).slice(0, 4);
  if (browser && browser.payload.type === 'browser_state' && browser.payload.url) {
    const browserHost = hostOf(browser.payload.url);
    for (const text of texts) {
      if (text.payload.type !== 'text') continue;
      const mentioned = text.payload.text.match(/https?:\/\/[^\s]+/i)?.[0];
      const mentionedHost = mentioned ? hostOf(mentioned) : '';
      if (mentionedHost && browserHost && mentionedHost !== browserHost) {
        conflicts.push({
          kind: 'text_vs_evidence_mismatch',
          description: `Text mentions "${mentioned}" but the browser reports "${browser.payload.url}"`,
          sourceA: { observationId: text.id, type: 'text', aspect: 'mentioned URL', quote: mentioned, confidence: text.confidence },
          sourceB: { observationId: browser.id, type: 'browser_state', aspect: 'current URL', quote: browser.payload.url, confidence: browser.confidence },
          resolution: 'prefer_B',
        });
      }
    }
  }

  return conflicts;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

// ----------------------------------------------------------------- reasoning

export interface ReasonerOptions {
  provider?: MultimodalReasoningProvider | null;
  providerTimeoutMs?: number;
  signal?: AbortSignal;
}

export class MultimodalReasoner {
  private provider: MultimodalReasoningProvider | null = null;

  setProvider(provider: MultimodalReasoningProvider | null): void {
    this.provider = provider;
  }

  getProvider(): MultimodalReasoningProvider | null {
    return this.provider;
  }

  /**
   * Answer a cross-modal question from the bounded context. Fully
   * deterministic without a provider; with a provider, low-confidence
   * answers may be enriched via a redacted digest (spec §15).
   */
  async answer(context: MultimodalContext, question: MultimodalQuestion, options: ReasonerOptions = {}): Promise<MultimodalConclusion> {
    const now = Date.now();
    const intent = classifyQuestion(question.question);
    const { supporting, reasoning } = this.collectEvidence(context, intent, question.question, now);

    const conflicts = detectConflicts(context, now);
    const conflictsFor = filterRelevantConflicts(conflicts, supporting);
    const uncertainty = computeUncertainty(question.question, supporting, conflictsFor.length);

    const confidence = computeConfidence(supporting, conflictsFor.length, uncertainty);
    const statement = this.statementFor(context, intent, question.question, supporting, now);

    let conclusion: MultimodalConclusion = {
      claim: statement,
      confidence,
      uncertainty,
      supporting,
      conflicting: conflictsFor.flatMap((c) => [c.sourceA, c.sourceB]),
      conflicts: conflictsFor,
      uncertainties: this.uncertaintiesFor(intent, supporting, conflictsFor),
      requiredVerification: this.requiredVerificationFor(conflictsFor, uncertainty, intent),
      requiresVerification: conflictsFor.length > 0 || uncertainty > 0.5 || (supporting.length === 0 && intent !== 'general_question'),
      reasoning,
      reasoningSource: 'local',
    };

    // Provider enrichment ONLY when the local evidence is weak (spec §15).
    const activeProvider = options.provider ?? this.provider;
    if (activeProvider && (conclusion.uncertainty >= PROVIDER_TRIGGER_UNCERTAINTY || conclusion.supporting.length === 0)) {
      try {
        if (question.signal?.aborted || options.signal?.aborted) return conclusion;
        const digest = context.providerSafeDigest();
        const enriched = await raceWithSignal(
          activeProvider.reason({ question: question.question, boundedContext: digest, conclusion }, options.signal ?? question.signal),
          options.providerTimeoutMs ?? 12_000
        );
        if (enriched) {
          conclusion = {
            ...enriched,
            conflicts: conclusion.conflicts,
            uncertainties: conclusion.uncertainties,
            requiredVerification: conclusion.requiredVerification,
            reasoning: [...conclusion.reasoning, `enriched by provider "${activeProvider.id}"`],
            provider: activeProvider.id,
            reasoningSource: 'provider',
          };
        }
      } catch {
        // Provider failure changes nothing — local result stands.
      }
    }

    return conclusion;
  }

  // ------------------------------------------------------------ evidence

  private collectEvidence(
    context: MultimodalContext,
    intent: string,
    question: string,
    now: number
  ): { supporting: EvidenceRef[]; reasoning: string[] } {
    const reasoning: string[] = [];
    const terms = new Set(tokenize(question));
    const scores = new Map<string, { obs: ModalityObservation; score: number; aspect: string; quote?: string }>();

    const consider = (obs: ModalityObservation, aspect: string, quote: string | undefined, weight: number) => {
      const keywords = (obs.metadata['keywords'] as string[] | undefined) ?? [];
      let overlap = 0;
      for (const k of keywords) if (terms.has(k)) overlap += 1;
      // The priority drives ordering; overlap only makes evidence relevant.
      const score = context.priorityOf(obs, now) * weight + overlap * 5;
      const prev = scores.get(obs.id);
      if (!prev || score > prev.score) scores.set(obs.id, { obs, score, aspect, quote });
    };

    switch (intent) {
      case 'active_application': {
        const apps = context.byType('application_state', now).filter((o) => o.payload.type === 'application_state' && o.payload.focused === true);
        for (const o of apps) consider(o, 'focused application', o.payload.type === 'application_state' ? o.payload.name : undefined, 1.2);
        const screens = context.byType('ui_state', now);
        for (const o of screens) {
          consider(o, 'active window title', o.payload.type === 'ui_state' ? o.payload.summary.activeWindowTitle : undefined, 1.0);
        }
        reasoning.push(`considered ${apps.length} focused-application record(s) and ${screens.length} screen observation(s)`);
        break;
      }
      case 'find_element': {
        const target = extractTarget(question).toLowerCase();
        for (const o of context.byType('ui_state', now)) {
          if (o.payload.type !== 'ui_state') continue;
          const s = o.payload.summary;
          const hit =
            s.buttons.find((b) => !target || b.toLowerCase().includes(target)) ??
            s.links.find((l) => !target || l.toLowerCase().includes(target)) ??
            s.texts.find((t) => target && t.toLowerCase().includes(target));
          if (hit !== undefined) consider(o, target ? `element matching "${target}"` : 'visible controls', hit, 1.2);
        }
        reasoning.push(`searched visible buttons/links/texts${target ? ` for "${target}"` : ''}`);
        break;
      }
      case 'summarize_document': {
        for (const o of context.byType('document', now)) {
          consider(o, 'document chunks', o.payload.type === 'document' ? o.payload.title : undefined, 1.2);
        }
        reasoning.push('collected retained document chunks');
        break;
      }
      case 'continue_workflow':
      case 'verify_state': {
        for (const type of ['tool_result', 'application_state', 'ui_state', 'browser_state'] as ModalityType[]) {
          for (const o of context.byType(type, now).slice(0, 4)) {
            consider(o, type, quoteOf(o), 1.0);
          }
        }
        reasoning.push('collected tool results, application state, and observations for verification');
        break;
      }
      default: {
        for (const o of context.live(now).slice(0, 12)) {
          consider(o, 'general', quoteOf(o), 1.0);
        }
        reasoning.push('collected the most recent observations across modalities');
      }
    }

    const supporting: EvidenceRef[] = Array.from(scores.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map(({ obs, aspect, quote }) => ({
        observationId: obs.id,
        type: obs.type,
        aspect,
        quote,
        confidence: obs.confidence,
      }));
    return { supporting, reasoning };
  }

  private statementFor(
    context: MultimodalContext,
    intent: string,
    question: string,
    supporting: EvidenceRef[],
    now: number
  ): string {
    if (intent === 'active_application') {
      const focused = context
        .byType('application_state', now)
        .find((o) => o.payload.type === 'application_state' && o.payload.focused === true);
      const screen = context.latest('ui_state', now);
      const windowTitle = screen && screen.payload.type === 'ui_state' ? screen.payload.summary.activeWindowTitle : undefined;
      if (focused && focused.payload.type === 'application_state') {
        return `The active application appears to be "${focused.payload.name}"${windowTitle ? ` (window: "${windowTitle}")` : ''}.`;
      }
      if (windowTitle) return `The active window appears to be "${windowTitle}".`;
      if (supporting.length > 0) return `Application focus is unclear from current evidence.`;
      return 'No application-focus evidence is available in the current context.';
    }
    if (intent === 'find_element') {
      const target = extractTarget(question);
      if (supporting.length > 0) {
        const ref = supporting[0];
        return `${target ? `"${capitalize(target)}"` : 'A matching control'} ${ref.quote ? `"${ref.quote}"` : ''} is visible on the current screen (${ref.type}).`;
      }
      return target
        ? `No element matching "${target}" was found in the current screen evidence.`
        : 'No matching element was found in the current screen evidence.';
    }
    if (intent === 'summarize_document') {
      if (supporting.length === 0) return 'No document content is loaded in the current context.';
      const doc = context.byType('document', now)[0];
      if (doc && doc.payload.type === 'document') {
        const chunks = this.retainedChunks(context, doc.id);
        const excerpt = chunks[0]?.slice(0, 200) ?? '';
        return `Document "${doc.payload.title}" (${doc.payload.totalChars} chars) begins: "${excerpt}…"`;
      }
      return 'Document content is available but could not be summarized from retained chunks.';
    }
    if (supporting.length === 0) return 'Insufficient evidence in the current context to answer.';
    const top = supporting[0];
    return `Based on ${top.type} evidence (${top.aspect}${top.quote ? `: "${top.quote}"` : ''}), the best-supported answer to "${question}" is available with the confidence shown below.`;
  }

  private retainedChunks(context: MultimodalContext, observationId: string): string[] {
    const obs = context.live().find((o) => o.id === observationId);
    if (obs && obs.payload.type === 'document') {
      const stored = obs.metadata['chunks'];
      if (Array.isArray(stored)) return stored as string[];
    }
    return [];
  }

  private uncertaintiesFor(intent: string, supporting: EvidenceRef[], conflicts: ModalityConflict[]) {
    const uncertainties: NonNullable<MultimodalConclusion['uncertainties']> = [];
    if (supporting.length === 0) {
      uncertainties.push({ reason: 'no relevant evidence in the current context' });
    }
    if (supporting.length === 1 && intent !== 'summarize_document') {
      uncertainties.push({
        reason: 'only one modality supports this conclusion; independent confirmation is missing',
        needsKind: intent === 'active_application' ? 'application_state' : 'ui_state',
      });
    }
    for (const c of conflicts) {
      if (c.resolution === 'requires_verification' || c.resolution === 'unresolved') {
        uncertainties.push({ reason: `unresolved conflict: ${c.description}` });
      }
    }
    return uncertainties;
  }

  private requiredVerificationFor(conflicts: ModalityConflict[], uncertainty: number, intent: string): string[] {
    const steps: string[] = [];
    for (const c of conflicts) {
      if (c.kind === 'browser_url_mismatch') steps.push('re-observe the screen and refresh browser state to reconcile the URL');
      if (c.kind === 'application_presence_mismatch') steps.push(`verify window presence for the reported application`);
      if (c.kind === 'stale_state_contradiction') steps.push('capture a fresh screen observation and discard the stale one');
    }
    if (uncertainty > 0.5 && intent === 'find_element') steps.push('capture a fresh screen observation before clicking anything');
    if (intent === 'continue_workflow' && uncertainty > 0.3) steps.push('verify the current UI state matches the workflow expectation before continuing');
    return Array.from(new Set(steps));
  }
}

// ------------------------------------------------------------------ helpers

function quoteOf(obs: ModalityObservation): string | undefined {
  switch (obs.payload.type) {
    case 'text':
      return obs.payload.text.slice(0, 120);
    case 'application_state':
      return `${obs.payload.name} running=${obs.payload.running}`;
    case 'browser_state':
      return obs.payload.url;
    case 'tool_result':
      return obs.payload.toolName;
    case 'ui_state':
    case 'screenshot':
      return obs.payload.summary.activeWindowTitle;
    default:
      return undefined;
  }
}

/** Keep only conflicts whose sides appear in the supporting evidence (or all when none do). */
function filterRelevantConflicts(conflicts: ModalityConflict[], supporting: EvidenceRef[]): ModalityConflict[] {
  if (conflicts.length === 0) return [];
  const ids = new Set(supporting.map((s) => s.observationId));
  const relevant = conflicts.filter((c) => ids.has(c.sourceA.observationId) || ids.has(c.sourceB.observationId));
  return relevant.length > 0 ? relevant : conflicts.slice(0, 1);
}

/**
 * Confidence from evidence quality (spec §7): weighted mean of supporting
 * confidences (weights rise with effective priority), penalized by conflicts
 * and uncertainty; a single-source factual claim is capped; no evidence → 0.
 */
export function computeConfidence(supporting: EvidenceRef[], conflictCount: number, uncertainty: number): number {
  if (supporting.length === 0) return 0;
  let weightSum = 0;
  let weighted = 0;
  supporting.forEach((ref, index) => {
    const weight = 1 / (index + 1); // best evidence first
    weightSum += weight;
    weighted += weight * ref.confidence;
  });
  let confidence = weighted / weightSum;
  confidence -= conflictCount * CONFLICT_CONFIDENCE_PENALTY;
  confidence *= 1 - 0.5 * uncertainty;
  if (supporting.length === 1) confidence = Math.min(confidence, 0.6);
  return Math.max(0, Math.min(1, Number(confidence.toFixed(3))));
}

/** Uncertainty: missing coverage + conflicts (deterministic). */
export function computeUncertainty(question: string, supporting: EvidenceRef[], conflictCount: number): number {
  const terms = new Set(tokenize(question));
  let base = 0.35;
  if (supporting.length === 0) base = 0.95;
  else if (supporting.length === 1) base = 0.55;
  else if (supporting.length >= 3) base = 0.2;
  const conflictBoost = Math.min(0.4, conflictCount * 0.2);
  void terms;
  return Math.min(1, Number((base + conflictBoost).toFixed(3)));
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

async function raceWithSignal<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

/** Deterministic digest id for telemetry (hash of question + evidence ids). */
export function conclusionId(question: string, supporting: EvidenceRef[]): string {
  return contentHash(question + supporting.map((s) => s.observationId).join(','));
}
