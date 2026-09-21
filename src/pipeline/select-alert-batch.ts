import type { FilterDecision } from '../domain/filter-result.js';
import type { OpportunityKey } from '../domain/opportunity.js';
import { dailyAllowance, type DailyAllowance } from '../notify/daily-limit.js';
import { compareForAlert } from '../filter/ranking.js';
import type { OpportunityStore, StoredOpportunity } from '../storage/opportunity-store.js';

export interface AlertBatchOptions {
  /** Identifies the collection: the instant the run started, before anything was collected. */
  batchId: string;
  /** Decisions that may be alerted (top_match, shortlist, review by default). */
  decisions: readonly FilterDecision[];
  /** Most alerts owed at once, blue ones included. */
  cap: number;
  /** The personal limit of alerts confirmed per calendar day (America/Sao_Paulo). Omit for none. */
  dailyCap?: number;
  /** Hours after which the collected data of a source is too old to alert from. */
  maxAgeHoursBySource?: Readonly<Record<string, number>>;
  now: Date;
}

export interface AlertBatchReport {
  batchId: string;
  cap: number;
  /** Selected by an earlier collection, still undelivered and fresh: they keep their place, retried first. */
  carriedOver: OpportunityKey[];
  /** Selected earlier but stale by now: no longer owed. */
  expired: number;
  /** New opportunities of this collection that compete for the free slots, by decision. */
  candidates: Record<FilterDecision, number>;
  /** New opportunities selected now. */
  selected: OpportunityKey[];
  selectedByDecision: Record<FilterDecision, number>;
  /** New opportunities left out: stored and consultable, never alerted automatically. */
  overflow: number;
  /** What this run may deliver, retries first: carried over, then newly selected. */
  alertKeys: OpportunityKey[];
  /** Owed opportunities that no automatic alert will pick (older than any batch, or overflow). */
  backlog: number;
  /** The daily allowance at selection time, when a daily limit is configured. */
  daily: DailyAllowance | null;
}

const zero = (): Record<FilterDecision, number> => ({ top_match: 0, shortlist: 0, review: 0, skip: 0 });

/**
 * The persistent alert batch of one collection. ONLY opportunities stored for the first time by this collection compete;
 * the best ones (top match, then shortlist, then review, by the usual ranking) are recorded as `selected` up to the cap,
 * counting the ones still owed from an earlier collection, and the rest as `overflow`. The record is written before any
 * sending, so a failed delivery is retried by the next run and nothing selected is lost; and the old backlog, which was
 * never selected, is never drained automatically. Nothing here touches `notified_at`.
 */
export function selectAlertBatch(store: OpportunityStore, options: AlertBatchOptions): AlertBatchReport {
  const { batchId, decisions, cap, now } = options;
  const at = now.toISOString();
  const isFresh = (stored: StoredOpportunity): boolean => {
    const maxAge = options.maxAgeHoursBySource?.[stored.opportunity.sourceId];
    return maxAge === undefined || now.getTime() - Date.parse(stored.opportunity.fetchedAt) <= maxAge * 3_600_000;
  };

  // 1. What is still owed from earlier batches keeps its place; what went stale is released.
  const carriedOver: OpportunityKey[] = [];
  const stale: OpportunityKey[] = [];
  for (const key of store.alertQueue.listSelectedPending(decisions)) {
    const stored = store.get(key);
    if (stored && isFresh(stored)) carriedOver.push(key);
    else stale.push(key);
  }
  store.alertQueue.expire(stale);

  // 2. The new opportunities of this collection compete for the remaining slots.
  const ranked = store
    .alertQueue.listNewCandidates(batchId, decisions)
    .map((key) => ({ key, stored: store.get(key) }))
    .filter((entry): entry is { key: OpportunityKey; stored: StoredOpportunity } => entry.stored !== null)
    .sort((a, b) => compareForAlert(a.stored, b.stored));
  // Slots: the run cap, and what the day still allows (blue ones never exceed it); what is still owed keeps its place first.
  const daily = options.dailyCap === undefined ? null : dailyAllowance(store, now, options.dailyCap);
  const room = daily === null ? cap : Math.min(cap, daily.remaining);
  const free = Math.max(0, room - carriedOver.length);
  const chosen = ranked.slice(0, free);
  const left = ranked.slice(free);

  const candidates = zero();
  const selectedByDecision = zero();
  for (const entry of ranked) candidates[entry.stored.filter.decision] += 1;
  for (const entry of chosen) selectedByDecision[entry.stored.filter.decision] += 1;

  store.alertQueue.record(batchId, at, [
    ...chosen.map((entry, index) => ({ key: entry.key, status: 'selected' as const, rank: index + 1, decision: entry.stored.filter.decision })),
    ...left.map((entry, index) => ({ key: entry.key, status: 'overflow' as const, rank: free + index + 1, decision: entry.stored.filter.decision })),
  ]);

  const selected = chosen.map((entry) => entry.key);
  return {
    batchId,
    cap,
    carriedOver,
    expired: stale.length,
    candidates,
    selected,
    selectedByDecision,
    overflow: left.length,
    alertKeys: [...carriedOver, ...selected],
    backlog: store.alertQueue.listBacklog(decisions).length,
    daily,
  };
}

/** Terminal lines for the batch of a collection. */
export function describeAlertBatch(report: AlertBatchReport): string[] {
  const c = report.candidates;
  const s = report.selectedByDecision;
  const day = report.daily ? ` | day ${report.daily.day}: ${report.daily.automaticToday} of ${report.daily.cap} automatic, ${report.daily.remaining} left` : '';
  return [
    `alert batch (cap ${report.cap}${day}): new opportunities ${c.top_match + c.shortlist + c.review} (top_match ${c.top_match}, shortlist ${c.shortlist}, review ${c.review})`,
    `  selected now ${report.selected.length} (top_match ${s.top_match}, shortlist ${s.shortlist}, review ${s.review}) | carried over from an earlier batch (unsent) ${report.carriedOver.length} | released as stale ${report.expired}`,
    `  saved, never alerted automatically: ${report.overflow} from this collection | backlog (owed, not selected) ${report.backlog}: use "npm run backlog" to consult or send it on purpose`,
  ];
}

