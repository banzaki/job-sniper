export interface KeywordRule {
  /** Canonical term reported in results. */
  term: string;
  /** Other spellings that count as the same term. */
  aliases?: readonly string[];
  /** Phrases that contain this term but mean something else; matches inside them are ignored. */
  except?: readonly string[];
}

/** Words that make a delivery transactional, matched in the title and in the start of the description. */
export interface TransactionalVocabulary {
  /** In the title, the delivery itself is about payments, checkout, ticketing or bookings. */
  titleTerms: readonly KeywordRule[];
  /** In the start of the description, a strongly transactional delivery (recurring billing, multiple gateways...). */
  central: readonly KeywordRule[];
  /** Payment objects that count only right after an implementing verb (`actions`). */
  objects: readonly KeywordRule[];
  /** Verb stems that mean implementing or repairing something ("integrat" matches integrate, integration...). */
  actions: readonly string[];
}

/**
 * Vocabulary to recognize work whose central goal is to fabricate views, clicks, impressions, traffic or engagement artificially
 * (prohibited or suspicious activity). Matched sentence by sentence, never as isolated words: see fabricated-engagement.ts.
 */
export interface FabricatedEngagementVocabulary {
  /** What is being counted: impressions, views, clicks, traffic, engagement, followers, likes... */
  metrics: readonly KeywordRule[];
  /** An automatic means: automatically, a bot, a script, unattended, headless... */
  automation: readonly KeywordRule[];
  /** What makes a hit: load, watch, view, click, visit, open, refresh... */
  actions: readonly KeywordRule[];
  /** Asking to raise the number: boost, generate, inflate, farm... (not merely to record it). */
  purposes: readonly KeywordRule[];
  /** Wording that only makes sense for fake results: fake, artificial, click farm, ad fraud, bot traffic... */
  explicit: readonly KeywordRule[];
  /** Asking to look natural to the platform: rotating proxies, avoiding detection, human-like traffic... */
  evasion: readonly KeywordRule[];
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
  /**
   * Words that name a technical deliverable (a site, an API, a bot, a fix...). Together with `offTopicTasks` they decide
   * whether the MAIN task of a freelance project is technical. Omit both to skip that check.
   */
  deliverableSignals?: readonly KeywordRule[];
  /** Words that name a main task that is not technology (payroll, story writing, trading...), whatever skills are tagged. */
  offTopicTasks?: readonly KeywordRule[];
  /**
   * USD equivalents a budget must fully reach for a TOP MATCH: a fixed price, and an hourly rate. A lower budget never
   * removes an opportunity and does not cap it: it is a caveat that lowers its ranking. Omit to judge no budget.
   */
  budgetFloors?: { fixedUsd: number; hourlyUsd: number };
  /** When the MAIN delivery is transactional (payments, checkout, subscriptions, ticketing) it is an advanced scope: a review. */
  transactionalScope?: TransactionalVocabulary;
  /**
   * Skills the profile explicitly does not offer (another language, native mobile, games, machine learning...). When one is
   * the CENTRAL skill of the work (the title, or the start of the description with no available skill named) it is a skip;
   * beside an available skill it is a doubt (review).
   */
  unavailableSkills?: readonly KeywordRule[];
  /** Marketing tasks (ads, SEO): not technology even beside a site word, unless the title names a strong skill. */
  offTopicUnlessStrong?: readonly KeywordRule[];
  /** Prohibited or suspicious work: fabricating views, clicks or impressions. It is a skip, whatever the skills or the pay. */
  fabricatedEngagement?: FabricatedEngagementVocabulary;
  /** Signs of a large scope (enterprise, marketplace, SaaS...): never a "top match", but not a doubt by themselves. */
  largeScopeSignals?: readonly KeywordRule[];
  /**
   * Canonical terms of `strongSignals` and `weakSignals` that are too generic to prove fit alone ("responsive", "front-end",
   * "site"...). A green (shortlist) needs a SPECIFIC skill, one of the other terms, in the title or the start of the
   * description. Omit to skip this check.
   */
  genericSignalTerms?: readonly string[];
  /**
   * Back-end work the profile does not offer. A strong word is one hit; two distinct weak words count as one hit. Central to the
   * work (in the title, or dominating the start of the description) with no specific skill up front it is a skip; beside a
   * specific skill it is a doubt (review).
   */
  backendWork?: { strong: readonly KeywordRule[]; weak: readonly KeywordRule[] };
}
