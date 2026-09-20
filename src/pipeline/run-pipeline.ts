import type { FilterDecision, FilterResult } from '../domain/filter-result.js';
import type { Opportunity, OpportunityKey } from '../domain/opportunity.js';
import { evaluateOpportunity } from '../filter/opportunity-filter.js';
import type { InterestProfile } from '../profile/interest-profile.js';
import type { OpportunitySource } from '../sources/opportunity-source.js';
import { SourceBlockedError } from '../sources/source-errors.js';
import type { OpportunityStore } from '../storage/opportunity-store.js';

export interface PipelineOptions {
  source: OpportunitySource;
  store: OpportunityStore;
  profile: InterestProfile;
  /** Upper bound on detail requests per run; the rest of the new items wait for the next run. */
  maxDetailsPerRun: number;
  now?: () => Date;
}

export interface ProcessedOpportunity {
  opportunity: Opportunity;
  filter: FilterResult;
}

export interface PipelineReport {
  listed: number;
  alreadyKnown: number;
  newFound: number;
  /** New items left for a later run because of maxDetailsPerRun. Not persisted, not duplicates. */
  deferred: number;
  detailsRequested: number;
  persisted: number;
  decisions: Record<FilterDecision, number>;
  failures: { externalId: string; message: string }[];
  /** Set when the source blocked access; the run stopped immediately. */
  aborted: string | null;
  processed: ProcessedOpportunity[];
}

/**
 * list -> known? -> details for new ones only -> normalize (done by the source) -> filter -> persist.
 * A new item is persisted only after its detail was fetched and filtered, so a failure leaves
 * nothing half-written and the item is simply new again on the next run.
 */
export async function runPipeline(options: PipelineOptions): Promise<PipelineReport> {
  const { source, store, profile, maxDetailsPerRun } = options;
  const now = options.now ?? (() => new Date());

  const report: PipelineReport = {
    listed: 0,
    alreadyKnown: 0,
    newFound: 0,
    deferred: 0,
    detailsRequested: 0,
    persisted: 0,
    decisions: { shortlist: 0, review: 0, skip: 0 },
    failures: [],
    aborted: null,
    processed: [],
  };

  const summaries = await source.listRecent();
  report.listed = summaries.length;

  const seenAt = now().toISOString();
  const known: OpportunityKey[] = [];
  const fresh: OpportunityKey[] = [];
  const visited = new Set<string>();
  for (const summary of summaries) {
    const key = { sourceId: summary.sourceId, externalId: summary.externalId };
    const id = `${key.sourceId}:${key.externalId}`;
    if (visited.has(id)) continue;
    visited.add(id);
    (store.has(key) ? known : fresh).push(key);
  }
  report.alreadyKnown = known.length;
  report.newFound = fresh.length;
  store.touchSeen(known, seenAt);

  const batch = fresh.slice(0, maxDetailsPerRun);
  report.deferred = fresh.length - batch.length;

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
