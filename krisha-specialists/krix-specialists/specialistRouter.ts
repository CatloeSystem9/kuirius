/**
 * specialistRouter.ts
 *
 * A deliberately lightweight router: no embeddings, no vector DB, no ML
 * model. It extracts candidate keywords from a request and matches them
 * against each specialist's routingTags, returning ranked candidates.
 *
 * This is meant as a first-pass filter. The Agent Core (the real "brain")
 * makes the final call on which specialist(s) to actually invoke — this
 * router only narrows the field and provides a defensible ranking.
 */
import type { SpecialistDefinition, RiskLevel } from "./specialistTypes";
import { SpecialistRegistry, defaultRegistry } from "./specialistRegistry";

export interface RoutingCandidate {
  specialist: SpecialistDefinition;
  /** Number of routing tags that matched the request. */
  matchCount: number;
  /** Which specific tags matched, for transparency/debugging. */
  matchedTags: string[];
}

export interface RoutingOptions {
  /** Maximum number of candidates to return. Default 5. */
  maxResults?: number;
  /** If set, only consider specialists at or below this risk level. */
  maxRiskLevel?: RiskLevel;
  /** If set, restrict candidates to these departments only. */
  departments?: SpecialistDefinition["department"][];
}

const RISK_ORDER: Record<RiskLevel, number> = {
  SAFE: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

/** Very small stopword list — enough for lightweight keyword extraction. */
const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "to",
  "for",
  "of",
  "in",
  "on",
  "and",
  "or",
  "with",
  "is",
  "are",
  "it",
  "this",
  "that",
  "my",
  "me",
  "i",
  "you",
  "please",
  "can",
  "could",
  "would",
  "should",
  "do",
  "does",
  "how",
  "what",
  "why",
  "we",
  "our",
  "be",
  "as",
  "from",
  "at",
  "into",
]);

/** Extracts lowercase candidate keywords/phrases from free text. */
function extractKeywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));

  // Include bigrams too, since many routing tags are two-word phrases
  // (e.g. "web research", "fact check").
  const bigrams: string[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    bigrams.push(`${words[i]} ${words[i + 1]}`);
  }

  return [...words, ...bigrams];
}

export class SpecialistRouter {
  constructor(private readonly registry: SpecialistRegistry = defaultRegistry) {}

  /**
   * Routes a free-text request to ranked candidate specialists.
   * This performs keyword extraction + tag matching only — it does not
   * call any model and does not invoke specialists itself.
   */
  route(requestText: string, options: RoutingOptions = {}): RoutingCandidate[] {
    const { maxResults = 5, maxRiskLevel, departments } = options;

    const keywords = extractKeywords(requestText);
    const matches = this.registry.matchByTags(keywords);

    let candidates: RoutingCandidate[] = matches.map(({ specialist, matchCount }) => ({
      specialist,
      matchCount,
      matchedTags: specialist.routingTags.filter((tag) =>
        keywords.includes(tag.toLowerCase())
      ),
    }));

    if (maxRiskLevel) {
      const ceiling = RISK_ORDER[maxRiskLevel];
      candidates = candidates.filter((c) => RISK_ORDER[c.specialist.riskLevel] <= ceiling);
    }

    if (departments && departments.length > 0) {
      const deptSet = new Set(departments);
      candidates = candidates.filter((c) => deptSet.has(c.specialist.department));
    }

    return candidates.slice(0, maxResults);
  }

  /**
   * Routes a request and returns candidates grouped by department, useful
   * when a request plausibly spans multiple specialist domains (e.g.
   * "research and compare three laptops" -> research + comparison + data).
   */
  routeMultiDepartment(requestText: string, maxPerDepartment = 2): RoutingCandidate[] {
    const all = this.route(requestText, { maxResults: this.registry.size });
    const perDept = new Map<string, RoutingCandidate[]>();

    for (const candidate of all) {
      const dept = candidate.specialist.department;
      const list = perDept.get(dept) ?? [];
      if (list.length < maxPerDepartment) {
        list.push(candidate);
        perDept.set(dept, list);
      }
    }

    return Array.from(perDept.values()).flat();
  }
}

export const defaultRouter = new SpecialistRouter();
