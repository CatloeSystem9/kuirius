/**
 * Knowledge Integration — compares new concepts against Krix's existing
 * knowledge before persisting.
 *
 * Guarantees:
 *  - Detects exact & near-duplicate concepts (merges instead of duplicating).
 *  - Detects contradictory information and flags it WITHOUT silently
 *    overwriting established knowledge.
 *  - Preserves provenance, confidence, and verification status.
 *  - Supports version history and rollback.
 *  - Optionally mirrors verified/user-provided concepts into the existing
 *    KnowledgeGraphFacade so the rest of Krix sees them too.
 */
import { similarity } from '../memory/similarity';
import type { KnowledgeGraphFacade } from '../knowledge';
import type { ConceptFormation } from './conceptFormation';
import type { LearningStore } from './learningStore';
import type {
  AcquiredConcept,
  KnowledgeIntegrationResult,
  Provenance,
} from './learningTypes';

const NEAR_DUPLICATE_THRESHOLD = 0.78;

export class KnowledgeIntegration {
  private readonly formation: ConceptFormation;
  private readonly knowledgeGraph?: KnowledgeGraphFacade;

  constructor(formation: ConceptFormation, knowledgeGraph?: KnowledgeGraphFacade) {
    this.formation = formation;
    this.knowledgeGraph = knowledgeGraph;
  }

  /**
   * Integrate incoming concepts into the durable LearningStore.
   * Each concept is processed independently and safely so a single failure
   * never corrupts previously validated knowledge.
   */
  integrate(
    incomingConcepts: AcquiredConcept[],
    store: LearningStore
  ): KnowledgeIntegrationResult[] {
    const results: KnowledgeIntegrationResult[] = [];

    for (const incoming of incomingConcepts) {
      const existingAll = store.getAllConcepts();

      // 1. Check contradictions first — never silently overwrite established knowledge
      const contradictions = this.formation.detectContradictions(incoming, existingAll);
      if (contradictions.length > 0) {
        const target = store.getConcept(contradictions[0].conceptId);
        if (target) {
          const cloned: AcquiredConcept = {
            ...target,
            contradictions: mergeContradictions(target.contradictions, contradictions),
            updatedAt: Date.now(),
          };
          store.saveConcept(cloned);
        }
        results.push({
          candidateId: incoming.id,
          action: 'flagged_conflict',
          conceptId: contradictions[0].conceptId,
          conflict: contradictions[0],
          reason: contradictions[0].description,
        });
        continue;
      }

      // 2. Check exact label match or near-duplicate definition
      const exactMatch = store.findConceptByLabel(incoming.label);
      const nearDuplicate =
        exactMatch ??
        existingAll.find(
          (e) =>
            similarity(
              `${e.label} ${e.definition}`,
              `${incoming.label} ${incoming.definition}`
            ) >= NEAR_DUPLICATE_THRESHOLD
        );

      if (nearDuplicate) {
        // Exact duplicate check: if identical definition & provenance already present, merge cleanly
        const merged = this.mergeConcept(nearDuplicate, incoming);
        store.saveConcept(merged);
        for (const rel of merged.relationships) {
          store.saveRelationship(rel);
        }
        this.mirrorToKnowledgeGraph(merged);
        results.push({
          candidateId: incoming.id,
          action:
            similarity(nearDuplicate.definition, incoming.definition) >= 0.92
              ? 'merged'
              : 'updated',
          conceptId: merged.id,
          reason: `Integrated with existing concept "${merged.label}" (v${merged.version})`,
        });
        continue;
      }

      // 3. New concept
      store.saveConcept(incoming);
      for (const rel of incoming.relationships) {
        store.saveRelationship(rel);
      }
      this.mirrorToKnowledgeGraph(incoming);
      results.push({
        candidateId: incoming.id,
        action: 'created',
        conceptId: incoming.id,
        reason: `Acquired new concept "${incoming.label}"`,
      });
    }

    return results;
  }

  /**
   * Roll back a concept to a previous version snapshot without losing
   * provenance or contradiction history.
   */
  rollbackConcept(
    conceptId: string,
    targetVersion: number,
    store: LearningStore
  ): AcquiredConcept | null {
    const concept = store.getConcept(conceptId);
    if (!concept) return null;
    const snap = concept.versionHistory.find((v) => v.version === targetVersion);
    if (!snap) return null;

    const nextVersion = concept.version + 1;
    const rolledBack: AcquiredConcept = {
      ...concept,
      definition: snap.definition,
      verificationStatus: snap.verificationStatus,
      confidence: snap.confidence,
      version: nextVersion,
      updatedAt: Date.now(),
      versionHistory: [
        ...concept.versionHistory.slice(-19),
        {
          version: nextVersion,
          definition: snap.definition,
          verificationStatus: snap.verificationStatus,
          confidence: snap.confidence,
          updatedAt: Date.now(),
          changeNote: `Rolled back to v${targetVersion}`,
        },
      ],
    };
    store.saveConcept(rolledBack);
    return rolledBack;
  }

  private mergeConcept(
    existing: AcquiredConcept,
    incoming: AcquiredConcept
  ): AcquiredConcept {
    const now = Date.now();
    const mergedProvenance = mergeProvenanceList(
      existing.provenance,
      incoming.provenance
    );

    const existingDef = existing.definition.trim();
    const incomingDef = incoming.definition.trim();
    const sim = similarity(existingDef, incomingDef);
    const shouldExtendDef =
      sim < 0.92 && !existingDef.toLowerCase().includes(incomingDef.toLowerCase());

    const nextDefinition = shouldExtendDef
      ? `${existingDef}; ${incomingDef}`.slice(0, 1800)
      : existingDef;

    const nextVersion = existing.version + (shouldExtendDef ? 1 : 0);
    const nextConfidence = Math.min(
      1,
      Math.max(existing.confidence, incoming.confidence) + (shouldExtendDef ? 0.03 : 0.02)
    );

    // Promote verification status only when stronger evidence arrives
    const nextVerification = strongerVerification(
      existing.verificationStatus,
      incoming.verificationStatus
    );

    const relMap = new Map(existing.relationships.map((r) => [r.id, r]));
    for (const rel of incoming.relationships) {
      relMap.set(rel.id, rel);
    }

    const prereqSet = new Set([
      ...existing.prerequisites,
      ...incoming.prerequisites,
    ]);

    const nextHistory = shouldExtendDef
      ? [
          ...existing.versionHistory.slice(-19),
          {
            version: nextVersion,
            definition: nextDefinition,
            verificationStatus: nextVerification,
            confidence: nextConfidence,
            updatedAt: now,
            changeNote: `Merged related knowledge from ${incoming.provenance[0]?.source ?? 'unknown'}`,
          },
        ]
      : existing.versionHistory;

    return {
      ...existing,
      definition: nextDefinition,
      relationships: Array.from(relMap.values()).slice(0, 24),
      prerequisites: Array.from(prereqSet).slice(0, 10),
      confidence: Math.round(nextConfidence * 1000) / 1000,
      verificationStatus: nextVerification,
      provenance: mergedProvenance,
      version: nextVersion,
      versionHistory: nextHistory,
      updatedAt: now,
    };
  }

  private mirrorToKnowledgeGraph(concept: AcquiredConcept): void {
    if (!this.knowledgeGraph) return;
    if (concept.verificationStatus === 'unverified') return;
    try {
      const node = this.knowledgeGraph.graph.upsertNode({
        type: 'memory',
        label: concept.label,
        properties: {
          conceptId: concept.id,
          verificationStatus: concept.verificationStatus,
          confidence: concept.confidence,
        },
      });
      if (!node) return;
      for (const rel of concept.relationships.slice(0, 5)) {
        const targetNode = this.knowledgeGraph.graph.upsertNode({
          type: 'memory',
          label: rel.toId.replace(/^concept_/, ''),
        });
        if (targetNode) {
          this.knowledgeGraph.graph.upsertEdge({
            sourceId: node.id,
            targetId: targetNode.id,
            relationship: rel.type === 'prerequisite' ? 'depends_on' : 'related_to',
            confidence: rel.strength,
            source: 'learning_mechanism',
          });
        }
      }
    } catch {
      // Knowledge Graph mirroring is best-effort
    }
  }
}

function mergeProvenanceList(a: Provenance[], b: Provenance[]): Provenance[] {
  const out = [...a];
  for (const item of b) {
    const dup = out.some(
      (p) => p.source === item.source && p.rawText.trim() === item.rawText.trim()
    );
    if (!dup) out.push(item);
  }
  return out.slice(-20);
}

function mergeContradictions(
  existing: AcquiredConcept['contradictions'],
  incoming: AcquiredConcept['contradictions']
): AcquiredConcept['contradictions'] {
  const map = new Map(existing.map((c) => [c.id, c]));
  for (const c of incoming) map.set(c.id, c);
  return Array.from(map.values()).slice(-10);
}

function strongerVerification(
  a: AcquiredConcept['verificationStatus'],
  b: AcquiredConcept['verificationStatus']
): AcquiredConcept['verificationStatus'] {
  const rank: Record<AcquiredConcept['verificationStatus'], number> = {
    unverified: 0,
    hypothesis: 1,
    user_provided: 2,
    fact: 3,
  };
  return rank[b] > rank[a] ? b : a;
}
