export type SourceId = string;

export interface OpportunityKey {
  sourceId: SourceId;
  externalId: string;
}

export interface OpportunitySummary extends OpportunityKey {
  title: string;
  url: string;
  summary: string | null;
  publishedAt: string | null;
  discoveredAt: string;
}

export interface OpportunityBudget {
  currency: string;
  kind: 'fixed' | 'hourly' | 'open' | 'unknown';
  min: number | null;
  max: number | null;
}

export interface Opportunity extends OpportunitySummary {
  description: string;
  category: string | null;
  subcategory: string | null;
  experienceLevel: string | null;
  skills: string[];
  budget: OpportunityBudget | null;
  proposalCount: number | null;
  interestedCount: number | null;
  status: 'open' | 'closed' | 'cancelled' | 'unknown';
  fetchedAt: string;
  sourceMetadata: Record<string, string | number | boolean | null>;
}

export function opportunityId(key: OpportunityKey): string {
  return `${key.sourceId}:${key.externalId}`;
}