/**
 * Knowledge Graph validator (v1) — fail-safe structural checks.
 *
 * Every mutating operation routes through here: invalid input is rejected
 * (returns false / null) instead of throwing, so graph work can never crash
 * Krisha. Also used during persisted-data recovery to salvage valid entries
 * and drop only the malformed ones.
 */
import type { EntityType, KnowledgeEdge, KnowledgeNode, RelationshipType } from './knowledgeTypes';
import { ENTITY_TYPES, RELATIONSHIP_TYPES } from './knowledgeTypes';

const MAX_ID_CHARS = 160;

export function isValidId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= MAX_ID_CHARS &&
    !/[\u0000-\u001f\u007f]/.test(id)
  );
}

export function isEntityType(type: unknown): type is EntityType {
  return typeof type === 'string' && (ENTITY_TYPES as readonly string[]).includes(type);
}

export function isRelationshipType(rel: unknown): rel is RelationshipType {
  return typeof rel === 'string' && (RELATIONSHIP_TYPES as readonly string[]).includes(rel);
}

function isValidTimestamp(t: unknown): boolean {
  return typeof t === 'number' && Number.isFinite(t) && t >= 0;
}

function isValidProperties(props: unknown, maxProps: number, maxValueChars: number): boolean {
  if (props === undefined) return true;
  if (props === null || typeof props !== 'object' || Array.isArray(props)) return false;
  const entries = Object.entries(props as Record<string, unknown>);
  if (entries.length > maxProps) return false;
  for (const [key, value] of entries) {
    if (!key) return false;
    let serialized: string;
    try {
      serialized = JSON.stringify(value ?? null);
    } catch {
      return false;
    }
    if (serialized && serialized.length > maxValueChars) return false;
  }
  return true;
}

export interface NodeShapeLimits {
  maxLabelChars: number;
  maxPropertiesPerNode: number;
  maxPropertyValueChars: number;
}

/** Structural validation for a node (id/type/label/properties/timestamps). */
export function validateNode(node: unknown, limits: NodeShapeLimits): node is KnowledgeNode {
  if (!node || typeof node !== 'object') return false;
  const n = node as Partial<KnowledgeNode>;
  if (!isValidId(n.id)) return false;
  if (!isEntityType(n.type)) return false;
  if (typeof n.label !== 'string' || n.label.trim().length === 0 || n.label.length > limits.maxLabelChars) return false;
  if (!isValidTimestamp(n.createdAt) || !isValidTimestamp(n.updatedAt)) return false;
  if (!isValidProperties(n.properties, limits.maxPropertiesPerNode, limits.maxPropertyValueChars)) return false;
  return true;
}

/** Structural validation for an edge (ids/relationship/confidence/timestamps). */
export function validateEdge(edge: unknown): edge is KnowledgeEdge {
  if (!edge || typeof edge !== 'object') return false;
  const e = edge as Partial<KnowledgeEdge>;
  if (!isValidId(e.id)) return false;
  if (!isValidId(e.sourceId) || !isValidId(e.targetId)) return false;
  if (e.sourceId === e.targetId) return false; // no self-loops in v1
  if (!isRelationshipType(e.relationship)) return false;
  if (!isValidTimestamp(e.createdAt) || !isValidTimestamp(e.updatedAt)) return false;
  if (e.confidence !== undefined && (typeof e.confidence !== 'number' || !Number.isFinite(e.confidence) || e.confidence < 0 || e.confidence > 1)) return false;
  if (e.source !== undefined && (typeof e.source !== 'string' || e.source.length > 80)) return false;
  return true;
}

/** Deterministic edge identity — used for duplicate prevention. */
export function edgeFingerprint(sourceId: string, relationship: RelationshipType, targetId: string): string {
  return `${sourceId}|${relationship}|${targetId}`;
}

/** Bound a label deterministically (used by the indexer before node creation). */
export function clampLabel(label: string, maxLabelChars: number): string {
  const clean = label.replace(/\s+/g, ' ').trim();
  return clean.length > maxLabelChars ? clean.slice(0, maxLabelChars - 1).trimEnd() + '…' : clean;
}
