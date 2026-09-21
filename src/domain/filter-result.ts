/**
 * The commercial ladder of a filtered opportunity:
 *  top_match  an excellent match (strong technical fit, clear scope, known budget above the floor, little competition)
 *  shortlist  technically compatible; budget or competition only lower its ranking
 *  review     a real doubt or gap: ambiguous, missing or advanced skill, short deadline, unclear requirements
 *  skip       irrelevant, closed, not technology, out of scope or incompatible; never notified
 */
export type FilterDecision = 'top_match' | 'shortlist' | 'review' | 'skip';

export interface FilterResult {
  decision: FilterDecision;
  /** Concrete, human-readable reasons behind the decision. */
  reasons: string[];
  matchedKeywords: string[];
  evaluatedAt: string;
  ruleVersion: string;
}
