export interface KeywordRule {
  /** Canonical term reported in results. */
  term: string;
  /** Other spellings that count as the same term. */
  aliases?: readonly string[];
  /** Phrases that contain this term but mean something else; matches inside them are ignored. */
  except?: readonly string[];
}

/** What a person is interested in, independent of any platform. */
export interface InterestProfile {
  name: string;
  /** Terms that prove compatibility on their own. */
  strongSignals: readonly KeywordRule[];
  /** Generic terms; never enough for a shortlist by themselves. */
  weakSignals: readonly KeywordRule[];
  /** Advanced or unrelated scope; prevents a shortlist that rests on generic words. */
  conflictSignals: readonly KeywordRule[];
  /** Categories or subcategories that are directly relevant. */
  directCategories: readonly string[];
  /** Wide parent categories that contain relevant and irrelevant work. */
  broadCategories: readonly string[];
  /** Categories clearly outside the profile. */
  excludedCategories: readonly string[];
  /** Categories that say nothing about the work ("Other"); never a reason to skip. */
  nonSpecificCategories: readonly string[];
  /** Languages the person can work in (ISO 639-1). A project in another language is at most a review. Omit to accept any. */
  languages?: readonly string[];
}
