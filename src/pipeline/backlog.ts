import type { FilterDecision } from '../domain/filter-result.js';
import type { OpportunityKey } from '../domain/opportunity.js';
import { compareForAlert } from '../filter/ranking.js';
import type { OpportunityStore, StoredOpportunity } from '../storage/opportunity-store.js';

export interface BacklogView {
  /** Fresh enough to alert from, best first (the usual ranking). */
  ready: { key: OpportunityKey; stored: StoredOpportunity }[];
  /** Too old for its source to alert from: still stored, not sendable. */
  stale: number;
  total: number;
}

/**
 * The owed opportunities that no automatic alert will ever pick, ranked. Read only: it changes nothing. Sending any of them is
 * a manual, explicit act (`npm run backlog -- --send`), never a side effect of a collection.
 */
export function viewBacklog(
  store: OpportunityStore,
  decisions: readonly FilterDecision[],
  options: { now: Date; maxAgeHoursBySource?: Readonly<Record<string, number>> },
): BacklogView {
  const keys = store.alertQueue.listBacklog(decisions);
  const ready: BacklogView['ready'] = [];
  let stale = 0;
  for (const key of keys) {
    const stored = store.get(key);
    if (!stored) continue;
    const maxAge = options.maxAgeHoursBySource?.[stored.opportunity.sourceId];
    if (maxAge !== undefined && !(options.now.getTime() - Date.parse(stored.opportunity.fetchedAt) <= maxAge * 3_600_000)) stale += 1;
    else ready.push({ key, stored });
  }
  ready.sort((a, b) => compareForAlert(a.stored, b.stored));
  return { ready, stale, total: keys.length };
}

/** The best `limit` sendable backlog items, for an explicit manual send. */
export function pickBacklog(view: BacklogView, limit: number): OpportunityKey[] {
  return view.ready.slice(0, Math.max(0, limit)).map((entry) => entry.key);
}
