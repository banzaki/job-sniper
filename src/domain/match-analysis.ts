export type Confidence = 'low' | 'medium' | 'high';

/** What the model may recommend. "wait" is never the model's call: it comes from access rules. */
export type ModelRecommendation = 'apply' | 'review' | 'skip';
export type Recommendation = ModelRecommendation | 'wait';

export type Complexity = 'low' | 'medium' | 'high';

/** Whether the candidate can act on the opportunity right now, whatever its technical fit. */
export type ActionabilityStatus = 'actionable' | 'restricted' | 'unknown';

export interface Actionability {
  status: ActionabilityStatus;
  /** Estimated moment the opportunity opens to everyone, when the source made that knowable. */
  publicAt: string | null;
  reason: string;
  /** Access rules change over time: always re-check the opportunity before applying. */
  refreshBeforeApplying: true;
}

export interface EffortEstimate {
  minHours: number;
  maxHours: number;
}

export interface PriceSuggestion {
  currency: 'BRL';
  min: number;
  max: number;
  rationale: string;
}

export type ProposalStatus = 'draft' | 'approved' | 'submitted' | 'discarded';

/** A proposal text kept apart from the analysis so editing/approval/submission can be added later. */
export interface ProposalDraft {
  language: string;
  text: string;
  status: ProposalStatus;
}

/**
 * How far the OWNER has verified the skills the delivery ESSENTIALLY depends on. "verified" only when there is
 * at least one essential skill and every one of them is confirmed; a single confirmed skill never releases an
 * "apply" while another essential skill is unverified, being learned, or outside the profile.
 */
export interface SkillVerification {
  status: 'verified' | 'unverified';
  /** Every skill the model judged essential for delivering the work. */
  essential: string[];
  /** Essential skills confirmed by the owner. */
  confirmed: string[];
  /** Essential skills that are only interests: competence not verified. */
  unverified: string[];
  /** Essential skills that are being learned (basic level). */
  learning: string[];
  /** Essential skills the profile does not cover at all, or lists as unavailable. */
  notCovered: string[];
  note: string | null;
}

/** AI assessment of one opportunity for one candidate. Independent of the deterministic filter. */
export interface MatchAnalysis {
  sourceId: string;
  externalId: string;
  provider: string;
  model: string;
  /** Exact model version reported by the provider, when it reports one. */
  modelVersion: string | null;
  analysisVersion: string;
  analyzedAt: string;
  /**
   * Technical-fit rating from 0 to 100. NOT a probability of winning, being hired or succeeding, and
   * never lowered by access restrictions.
   */
  score: number;
  confidence: Confidence;
  /** Final recommendation after access rules ("wait" when a compatible opportunity is restricted). */
  recommendation: Recommendation;
  /** What the model recommended before access rules, kept for calibration. */
  modelRecommendation: ModelRecommendation;
  technicalFit: string;
  matchedSkills: string[];
  /** How far the candidate's competence in the matched skills has been verified. */
  verification: SkillVerification;
  missingSkills: string[];
  risks: string[];
  clientQuestions: string[];
  effort: EffortEstimate;
  complexity: Complexity;
  price: PriceSuggestion;
  actionability: Actionability;
  proposal: ProposalDraft;
}
