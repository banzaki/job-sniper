import type {
  Opportunity,
  OpportunitySummary,
  SourceId,
} from '../domain/opportunity.js';

/** One page of recent opportunities, newest first. */
export interface ListingPage {
  items: OpportunitySummary[];
  /**
   * Opaque cursor for the following page, or null when the source has nothing further.
   * Only the source that issued it knows what it means (a page number, a token, ...).
   */
  nextCursor: string | null;
}

export interface OpportunitySource {
  readonly id: SourceId;

  /**
   * Lists recent opportunities, newest first. Omit `cursor` to start at the newest page;
   * pass the previous page's `nextCursor` to continue backwards in time.
   */
  listRecent(cursor?: string | null): Promise<ListingPage>;

  fetchDetail(externalId: string): Promise<Opportunity>;
}
