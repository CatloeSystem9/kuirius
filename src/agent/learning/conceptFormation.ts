/**
 * Concept Formation — transforms raw LearningCandidates into structured
 * AcquiredConcepts, relationships, prerequisites, contradictions, and gaps.
 *
 * Reuses `similarity` & `tokenize` (memory/similarity.ts), `hashKey`
 * (routing/cache.ts), and optional `SemanticIntelligence` / `KnowledgeGraphFacade`.
 * Never invents facts to fill missing information.
 */
import { similarity, tokenize } from '../memory/similarity';
import { hashKey } from '../routing/cache';
import type { SemanticIntelligence } from '../semantic';
import type {
  AcquiredConcept,
  ConceptContradiction,
  ConceptRelationship,
  LearningCandidate,
  VerificationStatus,
} from './learningTypes';

const NEGATION_RE = /\b(?:not|never|no longer|cannot|can't|isn't|aren't|doesn't|don't)\b/i;
const ANTONYM_PAIRS: Array<[RegExp, RegExp]> = [
  [/\bhigh[- ]level\b/i, /\blow[- ]level\b/i],
  [/\bcompiled\b/i, /\binterpreted\b/i],
  [/\bsynchronous\b/i, /\basynchronous\b/i],
  [/\bmutable\b/i, /\bimmutable\b/i],
  [/\btrue\b/i, /\bfalse\b/i],
  [/\bstatic\b/i, /\bdynamic\b/i],
  [/\bindentation\b/i, /\bcurly\s+braces?\b/i],
];

export class ConceptFormation {
  private readonly semantic?: SemanticIntelligence;

  constructor(semantic?: SemanticIntelligence) {
    this.semantic = semantic;
  }

  /**
   * Extract structured concepts from a candidate and connect them to existing
   * concepts without fabricating missing details.
   */
  extractConcepts(
    candidate: LearningCandidate,
    existingConcepts: AcquiredConcept[]
  ): { concepts: AcquiredConcept[]; uncertainties: string[] } {
    const text = candidate.content.trim();
    const { label, definition } = this.parseSubjectAndDefinition(text, candidate.context);
    const prerequisites = this.extractPrerequisites(text);
    const now = Date.now();
    const conceptId = `concept_${hashKey(label.toLowerCase())}`;

    const verificationStatus: VerificationStatus =
      candidate.source === 'academy'
        ? 'hypothesis'
        : candidate.source === 'conversation' || candidate.source === 'correction'
          ? 'user_provided'
          : 'unverified';

    const concept: AcquiredConcept = {
      id: conceptId,
      label,
      definition,
      relationships: [],
      prerequisites,
      knowledgeGaps: [],
      confidence: candidate.confidence,
      verificationStatus,
      provenance: [
        {
          source: candidate.source,
          sourceId: candidate.sessionId,
          timestamp: candidate.timestamp,
          rawText: text,
          confidence: candidate.confidence,
        },
      ],
      version: 1,
      versionHistory: [
        {
          version: 1,
          definition,
          verificationStatus,
          confidence: candidate.confidence,
          updatedAt: now,
          changeNote: `Initial formation from ${candidate.source}`,
        },
      ],
      contradictions: [],
      createdAt: now,
      updatedAt: now,
    };

    // Connect with existing concepts via token similarity + optional semantic expansion
    concept.relationships = this.linkExistingConcepts(concept, existingConcepts);
    concept.knowledgeGaps = this.identifyKnowledgeGaps(concept, existingConcepts);

    const uncertainties: string[] = [];
    if (concept.knowledgeGaps.length > 0) {
      uncertainties.push(
        `Missing prerequisite concepts for "${concept.label}": ${concept.knowledgeGaps.join(', ')}`
      );
    }
    if (verificationStatus === 'unverified') {
      uncertainties.push(`"${concept.label}" is unverified and requires validation`);
    }

    return { concepts: [concept], uncertainties };
  }

  /**
   * Detect contradictions against existing concepts.
   * Flags conflicts when two statements share the same subject/label but
   * express opposing polarity/antonyms or diverge sharply in definition.
   */
  detectContradictions(
    incoming: AcquiredConcept,
    existingConcepts: AcquiredConcept[]
  ): ConceptContradiction[] {
    const contradictions: ConceptContradiction[] = [];
    const incomingLabel = incoming.label.trim().toLowerCase();

    for (const existing of existingConcepts) {
      const sameSubject =
        existing.id === incoming.id ||
        existing.label.trim().toLowerCase() === incomingLabel;
      if (!sameSubject) continue;

      const sim = similarity(incoming.definition, existing.definition);
      const hasAntonymConflict = ANTONYM_PAIRS.some(
        ([a, b]) =>
          (a.test(existing.definition) && b.test(incoming.definition)) ||
          (b.test(existing.definition) && a.test(incoming.definition))
      );
      const polarityFlip =
        NEGATION_RE.test(existing.definition) !== NEGATION_RE.test(incoming.definition);

      if (hasAntonymConflict || (polarityFlip && sim < 0.65)) {
        contradictions.push({
          id: `contra_${hashKey(`${existing.id}|${incoming.definition}`)}`,
          conceptId: existing.id,
          conflictingText: incoming.definition,
          conflictingSource: incoming.provenance[0]?.source ?? 'conversation',
          description: `Conflicting definition for "${existing.label}": "${existing.definition}" vs "${incoming.definition}"`,
          detectedAt: Date.now(),
          resolved: false,
        });
      }
    }

    return contradictions;
  }

  /** Identify prerequisites that are not yet present in Krix's knowledge. */
  identifyKnowledgeGaps(
    concept: AcquiredConcept,
    existingConcepts: AcquiredConcept[]
  ): string[] {
    const knownLabels = new Set(
      existingConcepts.map((c) => c.label.trim().toLowerCase())
    );
    knownLabels.add(concept.label.trim().toLowerCase());

    return concept.prerequisites.filter(
      (prereq) => !knownLabels.has(prereq.trim().toLowerCase())
    );
  }

  private parseSubjectAndDefinition(
    text: string,
    context: Record<string, unknown>
  ): { label: string; definition: string } {
    // Pattern 1: "X: definition"
    const colonMatch = text.match(/^([A-Za-z0-9_ .+-]{2,50}):\s+(.+)$/);
    if (colonMatch) {
      return {
        label: this.cleanLabel(colonMatch[1]),
        definition: text,
      };
    }

    // Pattern 2: "<Subject> is/are/means/refers to/uses/requires <rest>"
    const copulaMatch = text.match(
      /^([A-Za-z0-9_ .+-]{2,50}?)\s+(?:is|are|means|refers to|defined as|uses|requires|consists of|enables|runs on)\s+(.+)$/i
    );
    if (copulaMatch) {
      return {
        label: this.cleanLabel(copulaMatch[1]),
        definition: text,
      };
    }

    // Fallback to explicit topic from context or leading tokens
    const topic = typeof context.topic === 'string' ? context.topic.trim() : '';
    if (topic) {
      return { label: this.cleanLabel(topic), definition: text };
    }

    const tokens = tokenize(text).slice(0, 3);
    const label = tokens.length > 0 ? tokens.join(' ') : text.slice(0, 30);
    return { label: this.cleanLabel(label), definition: text };
  }

  private cleanLabel(raw: string): string {
    return raw
      .replace(/^(?:the|a|an|in|for|about)\s+/i, '')
      .trim()
      .slice(0, 60);
  }

  private extractPrerequisites(text: string): string[] {
    const prereqs: string[] = [];
    const matches = text.matchAll(
      /\b(?:requires?|depends? on|needs?|assumes?)\s+(?:understanding\s+of\s+)?([A-Za-z0-9_ +-]{2,40}?)(?=[.,;!?]|\band\b|$)/gi
    );
    for (const m of matches) {
      const item = m[1]?.trim();
      if (item && item.length >= 2) prereqs.push(item);
    }
    return Array.from(new Set(prereqs)).slice(0, 5);
  }

  private linkExistingConcepts(
    concept: AcquiredConcept,
    existingConcepts: AcquiredConcept[]
  ): ConceptRelationship[] {
    const rels: ConceptRelationship[] = [];
    const now = Date.now();
    const expandedTerms = this.semantic
      ? new Set(
          this.semantic
            .expand(tokenize(concept.definition), { input: concept.definition })
            .map((e) => e.term.toLowerCase())
        )
      : new Set<string>();

    for (const existing of existingConcepts) {
      if (existing.id === concept.id) continue;

      const isPrereq = concept.prerequisites.some(
        (p) => p.toLowerCase() === existing.label.toLowerCase()
      );
      if (isPrereq) {
        rels.push({
          id: `rel_${hashKey(`${concept.id}|prerequisite|${existing.id}`)}`,
          fromId: concept.id,
          toId: existing.id,
          type: 'prerequisite',
          strength: 0.9,
          evidence: `Extracted prerequisite from "${concept.label}"`,
          createdAt: now,
        });
        continue;
      }

      const sim = similarity(
        `${concept.label} ${concept.definition}`,
        `${existing.label} ${existing.definition}`
      );
      const mentionsLabel =
        concept.definition.toLowerCase().includes(existing.label.toLowerCase()) ||
        expandedTerms.has(existing.label.toLowerCase());

      if (sim >= 0.25 || mentionsLabel) {
        rels.push({
          id: `rel_${hashKey(`${concept.id}|related|${existing.id}`)}`,
          fromId: concept.id,
          toId: existing.id,
          type: 'related',
          strength: Math.min(1, Math.max(0.4, sim)),
          evidence: mentionsLabel
            ? `Concept "${concept.label}" references "${existing.label}"`
            : `Semantic/token similarity (${sim.toFixed(2)})`,
          createdAt: now,
        });
      }
    }

    return rels.slice(0, 12);
  }
}
