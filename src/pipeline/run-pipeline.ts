import type { FilterDecision, FilterResult } from '../domain/filter-result.js';
import type { Opportunity, OpportunityKey } from '../domain/opportunity.js';
import { evaluateOpportunity } from '../filter/opportunity-filter.js';
import type { InterestProfile } from '../profile/interest-profile.js';
import type { ListingPage, OpportunitySource } from '../sources/opportunity-source.js';
import { SourceBlockedError } from '../sources/source-errors.js';
import type { OpportunityStore } from '../storage/opportunity-store.js';

export interface PipelineOptions {
  source: OpportunitySource;
  store: OpportunityStore;
  profile: InterestProfile;
  /** Upper bound on detail requests per run; the rest of the unseen items wait for the next run. */
  maxDetailsPerRun: number;
  /** Most listing pages read per run, starting from the newest. */
  maxPages: number;
  /** Stop paginating once this many unseen opportunities were collected. */
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

export interface PipelineReport {
  pagesScanned: number;
  /** Distinct summaries seen across all scanned pages. */
  discovered: number;
  alreadyKnown: number;
  /** Unseen summaries collected, newest first. */
  unseenCollected: number;
  /** Unseen items left for a later run because of maxDetailsPerRun. Not persisted, not duplicates. */
  deferred: number;
  detailsRequested: number;
  persisted: number;
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
 * Discovery, one listing page at a time and newest first:
 *   page -> known? (database) -> collect unseen -> next page only while more unseen are needed.
 * Then details are requested for unseen items only, normalized (by the source), filtered and
 * persisted. Known items are never fetched again, only marked as seen.
 *
 * Pagination stops as soon as the unseen target is reached, the page limit is reached, the
 * source runs out, a page brings nothing new to this run, the cursor makes no progress, or the
 * source fails. Not finding shortlist material is never a reason to keep going.
 *
 * A new item is persisted only after its detail was fetched and filtered, so a failure leaves
 * nothing half-written and the item is simply unseen again on the next run.
 */
export async function runPipeline(options: PipelineOptions): Promise<PipelineReport> {
  const { source, store, profile, maxDetailsPerRun, maxPages, targetNew } = options;
  const now = options.now ?? (() => new Date());

  const report: PipelineReport = {
    pagesScanned: 0,
    discovered: 0,
    alreadyKnown: 0,
    unseenCollected: 0,
    deferred: 0,
    detailsRequested: 0,
    persisted: 0,
    decisions: { shortlist: 0, review: 0, skip: 0 },
    failures: [],
    stopReason: 'source-exhausted',
    stopDetail: null,
    aborted: null,
    processed: [],
  };

  const seenAt = now().toISOString();
  const known: OpportunityKey[] = [];
  const unseen: OpportunityKey[] = [];
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
    for (const summary of fresh) {
      visited.add(idOf(summary));
      report.discovered += 1;
      const key = { sourceId: summary.sourceId, externalId: summary.externalId };
      (store.has(key) ? known : unseen).push(key);
    }

    if (unseen.length >= targetNew) {
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

  report.alreadyKnown = known.length;
  report.unseenCollected = unseen.length;
  store.touchSeen(known, seenAt);

  // A blocked source would refuse detail requests too: no further requests at all.
  if (report.aborted) {
    report.deferred = unseen.length;
    return report;
  }

  const batch = unseen.slice(0, maxDetailsPerRun);
  report.deferred = unseen.length - batch.length;

  for (const key of batch) {
    report.detailsRequested += 1;
    try {
      const opportunity = await source.fetchDetail(key.externalId);
      const filter = evaluateOpportunity(opportunity, profile, now());
      store.insert(opportunity, filter, seenAt);
      report.persisted += 1;
      report.decisions[filter.decision] += 1;
      report.processed.push({ opportunity, filter });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.failures.push({ externalId: key.externalId, message });
      if (error instanceof SourceBlockedError) {
        report.aborted = message;
        break;
      }
    }
  }

  return report;
}

function idOf(summary: { sourceId: string; externalId: string }): string {
  return `${summary.sourceId}:${summary.externalId}`;
}
