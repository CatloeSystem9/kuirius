/**
 * Learning-to-Learn — tracks measured outcomes of learning strategies,
 * identifies concepts that repeatedly cause difficulties, and flags revision
 * requirements based strictly on observed evidence.
 */
import { hashKey } from '../routing/cache';
import type { LearningStore } from './learningStore';
import type {
  LearningSource,
  LearningStrategyStat,
  RevisionRequirement,
} from './learningTypes';

const MIN_SAMPLES_FOR_PATTERN = 2;
const DIFFICULTY_REVISION_THRESHOLD = 3;

export class LearningToLearn {
  /**
   * Record an observed learning attempt outcome for a strategy & concept.
   * Never invents scores; updates exact counts and measured successRate.
   */
  trackAttempt(
    method: string,
    source: LearningSource,
    success: boolean,
    conceptId: string,
    store: LearningStore
  ): LearningStrategyStat {
    const id = `lstat_${hashKey(`${method}|${source}`)}`;
    const existing = store.getStrategy(id);
    const now = Date.now();

    const stat: LearningStrategyStat = existing
      ? {
          ...existing,
          conceptDifficulties: { ...existing.conceptDifficulties },
        }
      : {
          id,
          method,
          source,
          successCount: 0,
          failureCount: 0,
          successRate: 0,
          sampleSize: 0,
          conceptDifficulties: {},
          lastUpdatedAt: now,
        };

    if (success) stat.successCount += 1;
    else {
      stat.failureCount += 1;
      if (conceptId) {
        stat.conceptDifficulties[conceptId] =
          (stat.conceptDifficulties[conceptId] ?? 0) + 1;
        if (stat.conceptDifficulties[conceptId] >= DIFFICULTY_REVISION_THRESHOLD) {
          this.flagRevision(
            conceptId,
            `Repeated learning failures (${stat.conceptDifficulties[conceptId]}) under strategy "${method}"`,
            stat.conceptDifficulties[conceptId],
            store
          );
        }
      }
    }

    stat.sampleSize = stat.successCount + stat.failureCount;
    stat.successRate =
      stat.sampleSize > 0
        ? Math.round((stat.successCount / stat.sampleSize) * 1000) / 1000
        : 0;
    stat.lastUpdatedAt = now;

    store.saveStrategy(stat);
    return stat;
  }

  /**
   * Recommend the best-performing learning strategy for a given source based
   * on measured outcomes (requires >= MIN_SAMPLES_FOR_PATTERN).
   */
  suggestStrategy(source: LearningSource, store: LearningStore): string {
    const candidates = store
      .getAllStrategies()
      .filter(
        (s) =>
          (s.source === source || s.sampleSize >= MIN_SAMPLES_FOR_PATTERN) &&
          s.sampleSize >= MIN_SAMPLES_FOR_PATTERN
      )
      .sort(
        (a, b) => b.successRate - a.successRate || b.sampleSize - a.sampleSize
      );

    return candidates[0]?.method ?? 'standard';
  }

  /** Identify concepts that have triggered revision requirements. */
  getDifficultConcepts(store: LearningStore): RevisionRequirement[] {
    return store.getAllRevisions().filter((r) => !r.resolved);
  }

  private flagRevision(
    conceptId: string,
    reason: string,
    failureCount: number,
    store: LearningStore
  ): void {
    const id = `rev_${hashKey(conceptId)}`;
    const rev: RevisionRequirement = {
      id,
      conceptId,
      reason,
      failureCount,
      priority: failureCount >= 5 ? 'high' : 'medium',
      resolved: false,
      createdAt: Date.now(),
    };
    store.saveRevision(rev);
  }
}
