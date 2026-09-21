import type { FilterResult } from '../domain/filter-result.js';
import type { OpportunityKey } from '../domain/opportunity.js';
import { evaluateOpportunity, FILTER_RULE_VERSION } from '../filter/opportunity-filter.js';
import type { InterestProfile } from '../profile/interest-profile.js';
import type { OpportunityStore } from '../storage/opportunity-store.js';

export interface ReevaluationReport {
  reevaluated: number;
  /** Previous rule version -> how many rows carried it. */
  previousVersions: Record<string, number>;
  failures: { id: string; message: string }[];
}

/**
 * Re-runs the current filter over stored opportunities evaluated by another rule version,
 * so old decisions are never left frozen. Offline: reads the stored payload, never the source.
 * Only the filter columns change; first_seen_at and notified_at are untouched.
 */
export function reevaluateOutdated(
  store: OpportunityStore,
  profile: InterestProfile,
  now: Date = new Date(),
): ReevaluationReport {
  const report: ReevaluationReport = { reevaluated: 0, previousVersions: {}, failures: [] };
  const updates: { key: OpportunityKey; filter: FilterResult }[] = [];

  for (const key of store.listKeysNotEvaluatedWith(FILTER_RULE_VERSION)) {
    try {
      const stored = store.get(key);
      if (!stored) continue;
      updates.push({ key, filter: evaluateOpportunity(stored.opportunity, profile, now, store.exchangeRates) });
      const previous = stored.filter.ruleVersion;
      report.previousVersions[previous] = (report.previousVersions[previous] ?? 0) + 1;
    } catch (error) {
      report.failures.push({
        id: `${key.sourceId}:${key.externalId}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  store.updateFilters(updates);
  report.reevaluated = updates.length;
  return report;
}
