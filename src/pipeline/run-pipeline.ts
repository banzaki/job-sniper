import type { FilterDecision, FilterResult } from '../domain/filter-result.js';
import type { Opportunity, OpportunityKey } from '../domain/opportunity.js';
import { evaluateOpportunity } from '../filter/opportunity-filter.js';
import type { InterestProfile } from '../profile/interest-profile.js';
import type { ListingPage, OpportunitySource } from '../sources/opportunity-source.js';
import { SourceBlockedError, SourceNotFoundError } from '../sources/source-errors.js';
import type { OpportunityStore } from '../storage/opportunity-store.js';
import type { QueueCounts, QueueRow } from '../storage/queue-store.js';

export interface PipelineOptions {
  source: OpportunitySource;
  store: OpportunityStore;
  profile: InterestProfile;
  /** Most detail requests per run, shared between new and older pending items (see splitDetailBudget). */
  maxDetailsPerRun: number;
  /** Most listing pages read per run, starting from the newest. */
  maxPages: number;
  /** Stop paginating once this many NEW summaries (unknown to the database and the queue) were saved. */
  targetNew: number;
  now?: () => Date;
}

export type StopReason =
  | 'target-new-reached'
  | 'max-pages-reached'
  | 'source-exhausted'
  | 'repeated-page'
  | 'no-progress'
  | 'blocked'
  | 'source-error';

export interface ProcessedOpportunity {
  opportunity: Opportunity;
  filter: FilterResult;
}

/**
 * Counts are disjoint groups, never overlapping subsets:
 *   discovered = alreadyKnown + newSummaries + alreadyQueued
 *   detailsAttempted = detailsObtained + detailsFailed + detailsUnavailable
 */
export interface PipelineReport {
  pagesScanned: number;
  /** Distinct summaries seen on the scanned pages. */
  discovered: number;
  /** Summaries whose opportunity (detail) is already stored. */
  alreadyKnown: number;
  /** Summaries seen for the first time, saved to the queue before any detail request. */
  newSummaries: number;
  /** Summaries that were already in the queue (detail still pending, or unavailable). */
  alreadyQueued: number;
  detailsAttempted: number;
  detailsObtained: number;
  /** Attempts that failed but keep the item pending (temporary errors, or a first not-found answer). */
  detailsFailed: number;
  /** Items that this run proved unavailable (repeated not-found). */
  detailsUnavailable: number;
  /** Queue state after the run. */
  queue: QueueCounts;
  decisions: Record<FilterDecision, number>;
  failures: { externalId: string; message: string }[];
  stopReason: StopReason;
  /** Error text when stopReason is "blocked" or "source-error". */
  stopDetail: string | null;
  /** Set when the source blocked access at any stage; the run stopped immediately. */
  aborted: string | null;
  processed: ProcessedOpportunity[];
}

/**
 * How the detail budget is shared: half (rounded down) is reserved for OLDER pending items, oldest first, so
 * the old queue advances even when new items keep arriving; the rest goes to NEW items in scan order (newest
 * first). Whatever one group cannot use goes to the other. Items in backoff are not considered.
 */
export function splitDetailBudget<T>(budget: number, fresh: readonly T[], older: readonly T[]): T[] {
  const reservedOld = Math.min(Math.floor(budget / 2), older.length);
  const takeFresh = Math.min(budget - reservedOld, fresh.length);
  const takeOlder = Math.min(budget - takeFresh, older.length);
  return [...fresh.slice(0, takeFresh), ...older.slice(0, takeOlder)];
}

/**
 * Discovery, one listing page at a time and newest first. Every valid summary of a downloaded page is saved
 * to the persistent queue BEFORE any detail is requested, so nothing is lost when a page scrolls away or the
 * process stops. Pagination stops at the first of: new-summary target, page limit, end of the source, a page
 * with nothing new to this run, a cursor that makes no progress, or a source error/block.
 *
 * Then details are fetched for pending queue items (new and older, see splitDetailBudget), normalized by the
 * source, filtered and persisted; an item is "done" only after its opportunity is stored. Known opportunities
 * are never fetched again. Temporary failures keep the item pending with a retry delay; repeated "not found"
 * answers mark it unavailable with the reason.
 */
export async function runPipeline(options: PipelineOptions): Promise<PipelineReport> {
  const { source, store, profile, maxDetailsPerRun, maxPages, targetNew } = options;
  const now = options.now ?? (() => new Date());

  const report: PipelineReport = {
    pagesScanned: 0,
    discovered: 0,
    alreadyKnown: 0,
    newSummaries: 0,
    alreadyQueued: 0,
    detailsAttempted: 0,
    detailsObtained: 0,
    detailsFailed: 0,
    detailsUnavailable: 0,
    queue: { pending: 0, done: 0, unavailable: 0 },
    decisions: { shortlist: 0, review: 0, skip: 0 },
    failures: [],
    stopReason: 'source-exhausted',
    stopDetail: null,
    aborted: null,
    processed: [],
  };

  const runStartedAt = now().toISOString();
  const known: OpportunityKey[] = [];
  const newInScanOrder: OpportunityKey[] = [];
  const visited = new Set<string>();
  const requestedCursors = new Set<string>();
  let cursor: string | null = null;

  for (;;) {
    requestedCursors.add(cursor ?? '');

    let page: ListingPage;
    try {
      page = await source.listRecent(cursor);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.stopDetail = message;
      if (error instanceof SourceBlockedError) {
        report.stopReason = 'blocked';
        report.aborted = message;
      } else {
        report.stopReason = 'source-error';
      }
      break;
    }
    report.pagesScanned += 1;

    if (page.items.length === 0) {
      report.stopReason = 'source-exhausted';
      break;
    }

    // Overlap between pages is normal (new items push older ones down); a page with
    // nothing new to this run is not.
    const fresh = page.items.filter((summary) => !visited.has(idOf(summary)));
    if (fresh.length === 0) {
      report.stopReason = 'repeated-page';
      break;
    }
    // All valid summaries of a downloaded page are saved, even when the page overshoots the target.
    store.batch(() => {
      for (const summary of fresh) {
        visited.add(idOf(summary));
        report.discovered += 1;
        const key = { sourceId: summary.sourceId, externalId: summary.externalId };
        if (store.has(key)) {
          known.push(key);
          report.alreadyKnown += 1;
          continue;
        }
        if (store.queue.upsertDiscovered(summary, runStartedAt).isNew) {
          newInScanOrder.push(key);
          report.newSummaries += 1;
        } else {
          report.alreadyQueued += 1;
        }
      }
    });

    if (report.newSummaries >= targetNew) {
      report.stopReason = 'target-new-reached';
      break;
    }
    if (page.nextCursor === null) {
      report.stopReason = 'source-exhausted';
      break;
    }
    if (requestedCursors.has(page.nextCursor)) {
      report.stopReason = 'no-progress';
      break;
    }
    if (report.pagesScanned >= maxPages) {
      report.stopReason = 'max-pages-reached';
      break;
    }
    cursor = page.nextCursor;
  }

  store.touchSeen(known, runStartedAt);

  // A blocked source would refuse detail requests too: no further requests at all.
  if (!report.aborted) {
    await fetchDetails({ source, store, profile, maxDetailsPerRun, now, report, runStartedAt, newInScanOrder });
  }

  report.queue = store.queue.counts();
  return report;
}

async function fetchDetails(context: {
  source: OpportunitySource;
  store: OpportunityStore;
  profile: InterestProfile;
  maxDetailsPerRun: number;
  now: () => Date;
  report: PipelineReport;
  runStartedAt: string;
  newInScanOrder: readonly OpportunityKey[];
}): Promise<void> {
  const { source, store, profile, report, runStartedAt } = context;

  const due = store.queue.listPending(context.now().toISOString());
  const byId = new Map(due.map((row) => [idOf(row.key), row]));
  const fresh = context.newInScanOrder.map((key) => byId.get(idOf(key))).filter((row): row is QueueRow => row !== undefined);
  const freshIds = new Set(fresh.map((row) => idOf(row.key)));
  const older = due.filter((row) => !freshIds.has(idOf(row.key)) && row.firstDiscoveredAt < runStartedAt);

  for (const row of splitDetailBudget(context.maxDetailsPerRun, fresh, older)) {
    report.detailsAttempted += 1;
    const at = context.now().toISOString();
    try {
      const opportunity = await source.fetchDetail(row.key.externalId);
      const filter = evaluateOpportunity(opportunity, profile, context.now());
      store.persistDetail(opportunity, filter, at);
      report.detailsObtained += 1;
      report.decisions[filter.decision] += 1;
      report.processed.push({ opportunity, filter });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof SourceBlockedError) {
        report.detailsAttempted -= 1; // a block is not a failure of this item
        report.aborted = message;
        return;
      }
      const updated = store.queue.recordFailure(row.key, { at, message, notFound: error instanceof SourceNotFoundError });
      if (updated?.state === 'unavailable') report.detailsUnavailable += 1;
      else report.detailsFailed += 1;
      report.failures.push({ externalId: row.key.externalId, message });
    }
  }
}

function idOf(summary: { sourceId: string; externalId: string }): string {
  return `${summary.sourceId}:${summary.externalId}`;
}
