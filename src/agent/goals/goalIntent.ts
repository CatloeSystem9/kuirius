/**
 * Goal Continuity v1 — deterministic, local intent detection.
 *
 * Goal statements are recognized with conservative regex patterns in the
 * style of the Context Engine's MEMORY_PATTERNS: no AI calls, no embeddings,
 * no interpretation beyond the words on the page. Hypotheticals, questions
 * and casual chatter never create goals; soft interest creates a PROPOSED
 * goal that needs explicit confirmation before it becomes active.
 */
import { normalizeText, similarity, tokenSet } from '../memory/similarity';
import { GOAL_DUPLICATE_THRESHOLD, GOAL_LIFECYCLE_MATCH_THRESHOLD } from './goalTypes';
import type { GoalRecord } from './goalTypes';

export type GoalIntentKind = 'create' | 'complete' | 'pause' | 'resume' | 'abandon';

export interface GoalIntent {
  kind: GoalIntentKind;
  /** The objective clause the statement is about (verbs stripped, bounded). */
  subject: string;
  /** The commitment verb from the statement ("build", "set up") — used for a readable goal description. */
  verb?: string;
  /** true = explicit commitment (creates ACTIVE); false = soft interest (creates PROPOSED). */
  explicit: boolean;
}

/** Statements shorter than this are never goal statements. */
const MIN_TEXT_CHARS = 6;

/** Questions and hypotheticals never create or change goals. */
const HYPOTHESIS_RE = /\b(?:what\s+if|suppose|imagine|hypothetically|should\s+we|could\s+we|can\s+we|whether\s+we|is\s+it\s+possible)\b/i;
const QUESTION_START_RE = /^\s*(?:what|when|where|who|why|how|which|is|are|was|were|do|does|did|can|could|will|would|shall|should)\b/;

// ----------------------------------------------------------- create (active)

/** Explicit commitment — sufficient clarity for an ACTIVE goal. Verbs are captured for the goal description. */
const EXPLICIT_CREATE_RES: RegExp[] = [
  /\b(?:let's|lets|let\s+us)\s+(build|create|make|start|launch|set\s+up|implement|design|write|develop|work\s+on)\b/i,
  /\b(?:i|we)\s+(?:want|need|intend)\s+to\s+(build|create|make|start|launch|set\s+up|implement|design|write|develop|complete|deliver)\b/i,
  /\b(?:i'm|we're|i\s+am|we\s+are)\s+(?:going\s+to\s+)?(building|creating|making|starting|developing|launching)\b/i,
  /\b(?:i|we)\s+(?:plan|are\s+planning|am\s+planning)\s+to\s+(build|create|make|start|implement|launch|develop)\b/i,
  /\b(?:my|our)\s+goal\s+is\s+to\b/i,
];

/** Soft interest — only a PROPOSED goal, confirmed later by the user. */
const SOFT_CREATE_RES: RegExp[] = [
  /\b(?:i'm|i\s+am|we're|we\s+are)\s+thinking\s+(?:of|about)\b/i,
  /\b(?:i'm|i\s+am|we're|we\s+are)\s+considering\b/i,
  /\bconsidering\s+(?:building|creating|making|starting|developing)\b/i,
  /\bthinking\s+(?:of|about)\s+(?:building|creating|making|starting|developing)\b/i,
  /\b(?:how\s+about|what\s+about)\s+(?:we\s+)?(?:build|building|create|creating|make|making|start|starting)\b/i,
];

// ------------------------------------------------------- lifecycle statements

const COMPLETE_RES: RegExp[] = [
  /\b(?:we|i|they)\s+(?:have\s+|just\s+|finally\s+|officially\s+)*(?:completed|finished|wrapped\s+up|shipped|delivered|done\s+with)\b/i,
  /\b(?:that|this|it's|it\s+is|the\s+goal\s+is|the\s+objective\s+is)\s+(?:now\s+)?(?:done|finished|complete[d]?)\b/i,
];

const PAUSE_RES: RegExp[] = [
  /\bpause\s+(?:this|that|the|it|our|my)?\s*/i,
  /\bhold\s+off\s+on\b/i,
  /\bput\s+(?:this|that|it)\s+on\s+hold\b/i,
  /\bstop\s+working\s+on\b/i,
  /\bshelve\s+(?:this|that|the|it)\b/i,
  /\btake\s+a\s+break\s+from\b/i,
];

const RESUME_RES: RegExp[] = [
  /\b(?:continue|resume|carry\s+on)\b/i,
  /\bpick\s+(?:this|it|that)\s+(?:back\s+)?up\b/i,
  /\b(?:get|go)\s+back\s+to\b/i,
  /\bkeep\s+(?:working|going|building)\s+on\b/i,
  /\bwork\s+more\s+on\b/i,
];

const ABANDON_RES: RegExp[] = [
  /\b(?:abandon|give\s+up\s+on)\s+(?:this|that|the|our|my)\b/i,
  /\b(?:drop|forget|cancel)\s+(?:this|that|the)\s+(?:goal|objective|plan|effort|idea|feature)\b/i,
  /\bwe're\s+not\s+(?:doing|building|going\s+to\s+do)\s+this\b/i,
];

/** Strict, short confirmations ("yes", "go ahead") — only consumed when a PROPOSED goal is pending. */
const CONFIRM_RE = /^(?:yes|yeah|yep|yup|sure|confirmed|confirm|go\s+ahead|go\s+on|approved|correct|that's\s+right|sounds\s+good|do\s+it|let's\s+do\s+it|ok(?:ay)?|proceed)[\s!,.]*$/i;

/** Trailing filler stripped from extracted subjects. */
const TRAILING_FILLER_RE = /\s*(?:for\s+now|for\s+a\s+while|for\s+a\s+bit|anymore|please|then|today|tomorrow|this\s+week|next\s+week|later|now)[\s!.]*$/i;
/** Leading filler stripped from resume subjects ("continue working on X"). */
const LEADING_FILLER_RE = /^(?:working|to\s+work|focus(?:ing)?)\s+on\s+/i;

/** Generic nouns — a subject made only of these refers to "the current goal". */
const GENERIC_NOUNS = new Set(['goal', 'objective', 'project', 'task', 'plan', 'effort', 'work', 'thing', 'one', 'stuff']);

/** Small local vocabulary fold so "the app" and "this application" dedup together. */
function foldVocabulary(text: string): string {
  return text.replace(/\bapps?\b/gi, 'application');
}

function firstSentence(text: string): string {
  const cut = text.search(/[.!?\n;]/);
  return cut === -1 ? text : text.slice(0, cut);
}

/** Strip verbs/fillers from a captured clause down to the objective core. */
function cleanSubject(raw: string, maxChars: number): string {
  let subject = firstSentence(raw).trim();
  subject = subject.replace(TRAILING_FILLER_RE, '').replace(LEADING_FILLER_RE, '').trim();
  subject = subject.replace(/[\s.,;:!]+$/, '').trim();
  return foldVocabulary(subject).slice(0, maxChars);
}

/**
 * Pronouns/determiners and trailing-filler words that never identify WHICH
 * goal a statement is about. Local and deliberate: the shared memory
 * tokenizer plural-folds "this" → "thi" (its stopword filter runs after the
 * fold), so goal matching tokenizes with its own conservative word list.
 */
const NON_IDENTIFYING_WORDS = new Set([
  'this', 'that', 'it', 'the', 'a', 'an', 'those', 'these', 'said', 'same', 'current', 'above',
  'now', 'for', 'while', 'bit', 'please', 'then', 'today', 'tomorrow', 'week', 'later',
  'anymore', 'really', 'just', 'soon', 'finally', 'also', 'again',
]);

/** Content tokens of a phrase: local normalization, plural-folded, fillers dropped. */
function coreTokens(text: string): Set<string> {
  const words = normalizeText(text).split(' ').filter(Boolean);
  const out = new Set<string>();
  for (const word of words) {
    const stemmed = word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
    if (NON_IDENTIFYING_WORDS.has(word) || NON_IDENTIFYING_WORDS.has(stemmed)) continue;
    out.add(stemmed);
  }
  return out;
}

/** A subject made only of generic nouns ("this objective", "the project") is a pronoun reference. */
export function isGenericSubject(subject: string): boolean {
  const tokens = coreTokens(subject);
  return tokens.size === 0 || [...tokens].every((t) => GENERIC_NOUNS.has(t));
}

export function isConfirmationStatement(text: string): boolean {
  return text.trim().length <= 40 && CONFIRM_RE.test(text.trim());
}

/**
 * Detect a goal intent in a user message, or null when the message is a
 * question, a hypothetical, or ordinary conversation. Deterministic and
 * conservative by design.
 */
export function detectGoalIntent(text: string, maxSubjectChars = 200): GoalIntent | null {
  const trimmed = text.trim();
  if (trimmed.length < MIN_TEXT_CHARS) return null;
  if (QUESTION_START_RE.test(trimmed) || trimmed.endsWith('?')) return null;

  for (const re of ABANDON_RES) {
    const m = trimmed.match(re);
    if (m?.index !== undefined) {
      return { kind: 'abandon', subject: cleanSubject(trimmed.slice(m.index + m[0].length), maxSubjectChars), explicit: true };
    }
  }
  for (const re of COMPLETE_RES) {
    const m = trimmed.match(re);
    if (m?.index !== undefined) {
      return { kind: 'complete', subject: cleanSubject(trimmed.slice(m.index + m[0].length), maxSubjectChars), explicit: true };
    }
  }
  for (const re of PAUSE_RES) {
    const m = trimmed.match(re);
    if (m?.index !== undefined) {
      const subject = cleanSubject(trimmed.slice(m.index + m[0].length), maxSubjectChars);
      // A bare "pause" with no object at all is too ambiguous to act on.
      if (subject || /\b(?:this|that|it|the)\b/i.test(m[0])) {
        return { kind: 'pause', subject, explicit: true };
      }
    }
  }
  for (const re of RESUME_RES) {
    const m = trimmed.match(re);
    if (m?.index !== undefined) {
      return { kind: 'resume', subject: cleanSubject(trimmed.slice(m.index + m[0].length), maxSubjectChars), explicit: true };
    }
  }

  if (HYPOTHESIS_RE.test(trimmed)) return null;

  for (const re of EXPLICIT_CREATE_RES) {
    const m = trimmed.match(re);
    if (m?.index !== undefined) {
      const subject = cleanSubject(trimmed.slice(m.index + m[0].length), maxSubjectChars);
      if (subject) {
        return {
          kind: 'create',
          subject,
          ...(m[1] ? { verb: m[1].replace(/\s+/g, ' ').toLowerCase() } : {}),
          explicit: true,
        };
      }
      return null; // "let's build" with no object — nothing to record
    }
  }
  for (const re of SOFT_CREATE_RES) {
    const m = trimmed.match(re);
    if (m?.index !== undefined) {
      const subject = cleanSubject(trimmed.slice(m.index + m[0].length), maxSubjectChars);
      if (subject) return { kind: 'create', subject, explicit: false };
      return null;
    }
  }
  return null;
}

/**
 * Duplicate-goal prevention: a statement is the SAME goal as an existing
 * record when its token similarity clears the consolidation-grade threshold
 * OR when its content tokens are fully covered by the record's (a restated
 * subset, e.g. "the app" vs "Build this application"). Deterministic and
 * explainable — no embeddings.
 */
export function isSameGoalStatement(subject: string, description: string): boolean {
  if (similarity(subject, description) >= GOAL_DUPLICATE_THRESHOLD) return true;
  const subjectTokens = coreTokens(subject);
  if (subjectTokens.size === 0) return false;
  const descriptionTokens = tokenSet(description);
  for (const token of subjectTokens) {
    if (!descriptionTokens.has(token)) return false;
  }
  return true;
}

/**
 * Resolve which existing goal a lifecycle statement targets.
 * Generic subjects ("this objective") need EXACTLY ONE open goal — with
 * several open goals the statement is ambiguous and must not be applied.
 * Otherwise the best similarity match at or above the threshold wins.
 */
export function resolveGoalTarget(
  subject: string,
  openGoalsList: GoalRecord[]
): { goal: GoalRecord | null; ambiguous: boolean } {
  if (openGoalsList.length === 0) return { goal: null, ambiguous: false };
  if (isGenericSubject(subject)) {
    return openGoalsList.length === 1 ? { goal: openGoalsList[0], ambiguous: false } : { goal: null, ambiguous: true };
  }
  let best: GoalRecord | null = null;
  let bestScore = 0;
  for (const goal of openGoalsList) {
    const score = Math.max(
      similarity(subject, goal.description),
      similarity(subject, goal.originMessage ?? '')
    );
    if (score > bestScore) {
      bestScore = score;
      best = goal;
    }
  }
  return bestScore >= GOAL_LIFECYCLE_MATCH_THRESHOLD ? { goal: best, ambiguous: false } : { goal: null, ambiguous: false };
}
