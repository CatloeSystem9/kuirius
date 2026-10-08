/**
 * Context Analyzer (Context Engine v1) — deterministic, dependency-free
 * analysis of what the current request actually requires (spec §4).
 *
 * Lightweight keyword/regex classification — no model calls. It identifies
 * intent, relevant information types, and whether FRESH network information
 * is genuinely required vs locally/cache-available knowledge. The analyzer
 * never triggers retrieval or network itself.
 */
import type { ContextIntent, ContextRequest, ContextRequirements } from './contextTypes';

/** Domain terms — deterministically map request text to information needs. */
const NETWORK_PATTERNS: Array<{ re: RegExp; need: 'required' | 'optional'; why: string }> = [
  { re: /\b(latest|newest|breaking|today'?s?|this (week|morning|evening)|yesterday|right now|currently)\b.*\b(news|weather|score|price|stock|release|update|headline)/i, need: 'required', why: 'user asked for current external information' },
  { re: /\b(weather|forecast|temperature)\b/i, need: 'required', why: 'weather is inherently time-sensitive external data' },
  { re: /\b(stock|share price|crypto|exchange rate|currency)\b/i, need: 'required', why: 'market data is inherently time-sensitive external data' },
  { re: /\b(search (the )?(web|online|internet)|google (it|this)|look ?up online|browse the web)\b/i, need: 'required', why: 'user explicitly requested a web search' },
  { re: /\b(news|headlines|who won|release date|movie release|match score)\b/i, need: 'optional', why: 'topic usually benefits from fresh external sources' },
  { re: /\b(research|deep research|find (papers|articles|sources)|cite)\b/i, need: 'optional', why: 'research requests may need external sources' },
];

const MEMORY_PATTERNS: RegExp[] = [
  /\b(remember|i told you|my name|my favorite|i prefer|as i (said|mentioned)|recall|you know about me|what do you know)\b/i,
];

const TASK_PATTERNS: RegExp[] = [
  /\b(my|the|this) (project|repo|repository|code|app|application|tests?|build)\b/i,
  /\b(why (is|are|does|do)|fix|debug|diagnose|failing|failed|broken|error)\b/i,
  /\b(continue|resume|finish) (the )?(task|plan|work|job)\b/i,
];

const FILE_PATTERNS: RegExp[] = [
  /\b(file|folder|directory|document|pdf|spreadsheet|document|open .*\.(pdf|txt|doc|md|json|ts|js|py)|my (downloads|documents|desktop|pictures))\b/i,
];

const DEVICE_PATTERNS: RegExp[] = [
  /\b(open|launch|start|close|quit|kill) (the )?(app|application|program|browser|notepad|calculator|spotify|vs ?code|chrome|edge)\b/i,
  /\b(click|type|press|move (the )?(cursor|mouse)|screenshot|screen|scroll)\b/i,
  /\b(currently open|running|focused|active window)\b/i,
];

const CREATE_PATTERNS: RegExp[] = [
  /\b(write|create|make|generate|draft|compose|summar(y|ize)|translate|refactor|rename)\b/i,
];

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'your', 'with', 'that', 'this', 'have', 'from',
  'what', 'when', 'where', 'who', 'how', 'why', 'can', 'could', 'would', 'should', 'will', 'shall',
  'does', 'did', 'was', 'were', 'been', 'being', 'their', 'there', 'here', 'then', 'than', 'them',
  'they', 'its', "it's", 'into', 'onto', 'about', 'after', 'before', 'over', 'under', 'again',
  'please', 'just', 'very', 'really', 'some', 'any', 'all', 'get', 'got', 'has', 'had', 'him',
  'her', 'his', 'she', 'our', 'out', 'too', 'also', 'more', 'most', 'much', 'many', 'now', 'ok',
  'hey', 'hi', 'hello', 'thanks', 'thank', 'kya', 'hai', 'ho', 'na', 'me', 'mera', 'meri', 'tum',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/** Deterministic keyword extraction, bounded and deduplicated. */
export function extractKeywords(text: string, max = 12): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokenize(text)) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
      if (out.length >= max) break;
    }
  }
  return out;
}

function classifyIntent(text: string): ContextIntent {
  if (MEMORY_PATTERNS.some((re) => re.test(text))) return 'memory_query';
  if (NETWORK_PATTERNS.some((p) => p.re.test(text))) return 'research';
  if (TASK_PATTERNS.some((re) => re.test(text))) return 'diagnose';
  if (DEVICE_PATTERNS.some((re) => re.test(text))) return 'device_task';
  if (CREATE_PATTERNS.some((re) => re.test(text))) return 'create_or_modify';
  if (/\?\s*$/.test(text.trim()) || /^(what|who|when|where|why|how|is|are|do|does|can|tell me|explain)\b/i.test(text.trim())) return 'question';
  return 'chitchat';
}

/** Analyze a request into bounded, deterministic requirements. Never throws. */
export function analyzeContext(request: ContextRequest): ContextRequirements {
  const text = String(request.input ?? '').slice(0, 2000);
  const intent = classifyIntent(text);
  const keywords = extractKeywords(text);

  let networkNeed: ContextRequirements['networkNeed'] = 'none';
  let networkReason = 'no external information is required for this request';
  for (const p of NETWORK_PATTERNS) {
    if (p.re.test(text)) {
      networkNeed = p.need;
      networkReason = p.why;
      break;
    }
  }

  const needsMemory =
    intent === 'memory_query' ||
    intent === 'diagnose' ||
    intent === 'create_or_modify' ||
    MEMORY_PATTERNS.some((re) => re.test(text));

  const needsTaskState = intent === 'diagnose' || (intent === 'device_task' && Boolean(request.taskId));
  const needsProjectFiles = intent === 'diagnose' || FILE_PATTERNS.some((re) => re.test(text));
  const needsToolState = needsTaskState || intent === 'device_task';
  const needsEnvironment = intent === 'device_task';
  // Conversation matters for almost everything except pure lookups.
  const needsConversation = intent !== 'chitchat' || text.length > 0;

  // Stale tolerance: market/weather-style data is never stale-acceptable.
  const staleTolerant = networkNeed !== 'required';

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const complexity: ContextRequirements['complexity'] =
    wordCount > 40 || (needsTaskState && needsProjectFiles && needsMemory) ? 'complex' : wordCount > 12 ? 'moderate' : 'simple';

  return {
    intent,
    keywords,
    needsMemory,
    needsTaskState,
    needsConversation,
    needsToolState,
    needsEnvironment,
    needsProjectFiles,
    networkNeed,
    networkReason,
    staleTolerant,
    complexity,
  };
}
