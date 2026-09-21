/**
 * confirmed   - the OWNER verified the competence (at the scope stated in the note). Only this level
 *               may be presented as a competence.
 * unverified  - an interest or intention, competence NOT verified. Not "unavailable": it may be worked
 *               on, but it is never asserted as a competence and it caps a recommendation at "review".
 * learning    - being learned; may be mentioned only as basic or in progress, never as mastery.
 * unavailable - the candidate does not offer it; never to be claimed or promised.
 */
export type SkillLevel = 'confirmed' | 'unverified' | 'learning' | 'unavailable';

export interface CandidateSkill {
  name: string;
  level: SkillLevel;
  /** True when the skill is on the owner's interest list, whatever its verification level. */
  interest?: boolean;
  /** Where the level comes from. Documentation only: it does not affect analysis versioning. */
  evidence?: string;
  /** Scope or caveat, for example "basic" or "small projects". */
  note?: string;
  /** Other spellings, so local checks recognize the skill in free text. */
  aliases?: readonly string[];
}

/** What the candidate's account on a source can do. Keyed by source id in the profile. */
export interface SourceCapability {
  accountTier: string;
  /** False for a free account: restricted (premium-only) opportunities cannot be applied to. */
  canApplyToPremiumOnly: boolean;
}

/** Who the proposals are written for. The AI may state nothing that is not recorded here. */
export interface CandidateProfile {
  /** Used only to sign proposals. No other personal data belongs in this profile. */
  displayName: string;
  /**
   * Background the owner declared about himself. It calibrates how cautious an analysis must be and must
   * never be contradicted; it is NOT experience to cite in a proposal (that is recordedExperience).
   */
  declaredContext: readonly string[];
  skills: readonly CandidateSkill[];
  /**
   * Verified experience statements the proposal may repeat. Empty means none is recorded:
   * no employers, clients, projects, years of experience or certifications may be claimed.
   */
  recordedExperience: readonly string[];
  sourceCapabilities: Readonly<Record<string, SourceCapability>>;
}
