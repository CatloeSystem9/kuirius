/**
 * Text similarity utilities for memory dedup / conflict detection (Phase 2).
 * Lightweight, local, dependency-free: normalization + synonym folding +
 * Jaccard token similarity + containment scoring.
 */

/** Common words that carry no meaning for fact comparison. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'of', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'about', 'as',
  'and', 'or', 'but', 'so', 'than', 'then', 'that', 'this', 'these', 'those',
  'it', 'its', 'he', 'she', 'they', 'them', 'his', 'her', 'their',
  'i', 'me', 'my', 'mine', 'we', 'us', 'our', 'you', 'your',
  'do', 'does', 'did', 'doing', 'has', 'have', 'had', 'will', 'would', 'should',
  'can', 'could', 'just', 'very', 'really', 'always', 'like', 'likes',
  'user', 'users', 'krisha',
]);

/** Fold common synonyms to a canonical token so paraphrases compare equal. */
const SYNONYMS: Record<string, string> = {
  prefer: 'prefer',
  prefers: 'prefer',
  preferred: 'prefer',
  preference: 'prefer',
  like: 'prefer',
  likes: 'prefer',
  love: 'prefer',
  loves: 'prefer',
  enjoy: 'prefer',
  enjoys: 'prefer',
  favorite: 'prefer',
  favourite: 'prefer',
  favorites: 'prefer',
  favourites: 'prefer',
  concise: 'short',
  brief: 'short',
  short: 'short',
  answers: 'answer',
  answer: 'answer',
  replies: 'answer',
  response: 'answer',
  responses: 'answer',
  direct: 'direct',
  straightforward: 'direct',
  editor: 'editor',
  ide: 'editor',
  hates: 'avoid',
  hate: 'avoid',
  dislikes: 'avoid',
  dislike: 'avoid',
  avoids: 'avoid',
  avoid: 'avoid',
};

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(text: string): string[] {
  return normalizeText(text)
    .split(' ')
    .map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t))
    .map((t) => SYNONYMS[t] ?? t)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

/** Jaccard similarity between two token sets: |A∩B| / |A∪B|. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** True when one normalized string is contained in the other and sizes are comparable. */
export function containment(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) {
    const shorter = Math.min(na.length, nb.length);
    const longer = Math.max(na.length, nb.length);
    return shorter / longer >= 0.55 ? shorter / longer : 0;
  }
  return 0;
}

/** Combined similarity score in [0,1]: max of Jaccard and containment. */
export function similarity(a: string, b: string): number {
  return Math.max(jaccard(tokenSet(a), tokenSet(b)), containment(a, b));
}
