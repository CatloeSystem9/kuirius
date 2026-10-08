/**
 * Context Budget Manager (Context Engine v1) — bounded packing (spec §7).
 *
 * P0 (current instruction, constraints, active task state) is preserved even
 * under tight budgets; P4 is always discarded; low-value context is dropped
 * before high-value context; P0/P1 are never blindly truncated.
 */
import type { BudgetOutcome, ContextBudgetConfig, ContextItem, ContextPriority } from './contextTypes';
import { DEFAULT_CONTEXT_BUDGET } from './contextTypes';
import type { RankedItem } from './relevanceEngine';

function wordTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const cut = slice.lastIndexOf(' ');
  return (cut > maxChars * 0.6 ? slice.slice(0, cut) : slice).trimEnd() + '…';
}

/**
 * Pack ranked items into the budget. Deterministic:
 *  - iterate by priority tier then score,
 *  - per-priority caps and a global cap are enforced,
 *  - truncatable tiers (P2/P3) are word-truncated to fit before being dropped,
 *  - everything below P3 (P4) is dropped unconditionally.
 */
export function packWithinBudget(ranked: RankedItem[], budget: Partial<ContextBudgetConfig> = {}): BudgetOutcome {
  const config: ContextBudgetConfig = { ...DEFAULT_CONTEXT_BUDGET, ...budget };
  const caps: Record<ContextPriority, number> = { ...DEFAULT_CONTEXT_BUDGET.priorityCaps, ...budget.priorityCaps };

  const kept: ContextItem[] = [];
  const dropped: ContextItem[] = [];
  const usedByPriority: Record<ContextPriority, number> = { P0: 0, P1: 0, P2: 0, P3: 0, P4: 0 };
  let total = 0;
  let truncatedItems = 0;

  const tiers: Array<ContextItem['priority']> = ['P0', 'P1', 'P2', 'P3'];
  for (const tier of tiers) {
    for (const { item } of ranked.filter((r) => r.item.priority === tier)) {
      const remainingGlobal = config.maxChars - total;
      const remainingTier = caps[tier] - usedByPriority[tier];
      const allowance = Math.min(remainingGlobal, remainingTier);
      if (allowance <= 40) {
        dropped.push(item);
        continue;
      }
      let content = item.content;
      if (content.length > allowance) {
        if (config.truncatable.includes(tier)) {
          content = wordTruncate(content, allowance - 1);
          truncatedItems++;
        } else {
          // P0/P1 are never blindly truncated — they fit whole or are dropped;
          // smaller later items at the same tier still get their chance.
          dropped.push(item);
          continue;
        }
      }
      kept.push({ ...item, content, chars: content.length });
      usedByPriority[tier] += content.length;
      total += content.length;
    }
  }
  for (const { item } of ranked.filter((r) => r.item.priority === 'P4')) dropped.push(item);

  return { kept, dropped, charsUsed: total, truncatedItems };
}
