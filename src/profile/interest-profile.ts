export interface KeywordRule {
  /** Canonical term reported in results. */
  term: string;
  /** Other spellings that count as the same term. */
  aliases?: readonly string[];
}

/** What a person is interested in, independent of any platform. */
export interface InterestProfile {
  name: string;
  keywords: readonly KeywordRule[];
  /** Categories (or subcategories) that count as relevant on their own. */
  relevantCategories: readonly string[];
  /** Categories that say nothing about the work ("Other"); never a reason to skip. */
  nonSpecificCategories: readonly string[];
}
