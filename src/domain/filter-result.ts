export type FilterDecision = 'shortlist' | 'review' | 'skip';

export interface FilterResult {
  decision: FilterDecision;
  /** Concrete, human-readable reasons behind the decision. */
  reasons: string[];
  matchedKeywords: string[];
  evaluatedAt: string;
  ruleVersion: string;
}
