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

/** Who may act on an opportunity, independent of how well it fits anyone. */
export interface OpportunityAccess {
  kind: 'public' | 'premium_only' | 'unknown';
  /** ISO time the opportunity is estimated to open to everyone; null unless the source made it certain. */
  publicAt: string | null;
  /** The source's own wording for the restriction, unchanged. */
  rawLabel: string | null;
}

export const UNKNOWN_ACCESS: OpportunityAccess = { kind: 'unknown', publicAt: null, rawLabel: null };

export interface Opportunity extends OpportunitySummary {
  description: string;
  access: OpportunityAccess;
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