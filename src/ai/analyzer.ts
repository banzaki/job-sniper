import { createHash } from 'node:crypto';
import type { MatchAnalysis } from '../domain/match-analysis.js';
import type { Opportunity } from '../domain/opportunity.js';
import type { CandidateProfile } from '../profile/candidate-profile.js';

/**
 * Bump when the prompt, the output schema or the local validation rules change in a way that should
 * re-analyze stored opportunities.
 */
export const PROMPT_VERSION = 'ai-v3';

/**
 * Short fingerprint of everything in the candidate profile that can change an analysis: name, declared context, skills
 * (name, level, scope note, aliases, interest flag), recorded experience and source capabilities.
 * Evidence text and ordering are deliberately ignored.
 */
export function profileFingerprint(candidate: CandidateProfile): string {
  const canonical = {
    displayName: candidate.displayName,
    declaredContext: [...candidate.declaredContext],
    skills: [...candidate.skills]
      .map((skill) => ({
        name: skill.name,
        level: skill.level,
        note: skill.note ?? null,
        interest: skill.interest === true,
        aliases: [...(skill.aliases ?? [])].sort(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    recordedExperience: [...candidate.recordedExperience],
    capabilities: Object.keys(candidate.sourceCapabilities)
      .sort()
      .map((source) => [source, candidate.sourceCapabilities[source]]),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 8);
}

/**
 * The effective analysis version: prompt version plus profile fingerprint ("ai-v2+p1a2b3c4d").
 * Rows are unique per opportunity and this value, so a relevant profile change makes every stored
 * opportunity eligible again even with an unchanged prompt, while earlier results stay as history.
 */
export function analysisVersionFor(candidate: CandidateProfile): string {
  return `${PROMPT_VERSION}+p${profileFingerprint(candidate)}`;
}

export interface AnalyzerStats {
  /** HTTP requests attempted so far (retries included). */
  requests: number;
  /** HTTP status of the most recent response, or null when none arrived. */
  lastStatus: number | null;
}

export interface AnalysisInput {
  opportunity: Opportunity;
  candidate: CandidateProfile;
  /** Reference time for access rules; defaults to the current time. */
  now?: Date;
}

/** Provider-independent analysis contract. Implementations must never fall back to another provider or model. */
export interface OpportunityAnalyzer {
  readonly id: string;
  readonly model: string;
  /** Optional call statistics, for terminal evidence. Never contains headers or secrets. */
  readonly stats?: AnalyzerStats;
  /** Returns a fully validated analysis, or throws one of the Analysis*Error classes. */
  analyze(input: AnalysisInput): Promise<MatchAnalysis>;
}
