import type {
  Opportunity,
  OpportunitySummary,
  SourceId,
} from '../domain/opportunity.js';

export interface OpportunitySource {
  readonly id: SourceId;

  listRecent(): Promise<OpportunitySummary[]>;

  fetchDetail(externalId: string): Promise<Opportunity>;
}