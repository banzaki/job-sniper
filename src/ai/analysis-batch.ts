import type { MatchAnalysis } from '../domain/match-analysis.js';
import type { OpportunityKey } from '../domain/opportunity.js';
import type { CandidateProfile } from '../profile/candidate-profile.js';
import type { OpportunityStore } from '../storage/opportunity-store.js';
import { analysisVersionFor, type OpportunityAnalyzer } from './analyzer.js';
import {
  AnalysisInvalidOutputError,
  AnalysisQuotaError,
  AnalysisRejectedError,
  AnalysisUnavailableError,
} from './errors.js';

/** Consecutive provider outages after which the batch gives up (each one already had its retry). */
const MAX_CONSECUTIVE_UNAVAILABLE = 3;

export type BatchStopReason = 'completed' | 'quota-exhausted' | 'provider-rejected' | 'provider-unavailable';

export interface AnalysisBatchOptions {
  store: OpportunityStore;
  analyzer: OpportunityAnalyzer;
  candidate: CandidateProfile;
  /** At most this many analyses are attempted; the rest stay pending for the next run. */
  limit: number;
  /** Re-analyze opportunities that already have a successful analysis for this version. */
  force?: boolean;
  /** Analyze only this opportunity. */
  only?: OpportunityKey;
  now?: () => Date;
}

export interface AnalysisBatchReport {
  /** Eligible before the limit. */
  eligible: number;
  attempted: number;
  succeeded: number;
  failed: number;
  /** Eligible opportunities not analyzed in this run (limit, quota or an early stop). */
  leftPending: number;
  stopReason: BatchStopReason;
  stopDetail: string | null;
  failures: { id: string; message: string }[];
  analyses: MatchAnalysis[];
}

/**
 * What a batch would analyze, without calling any provider. Used by dry-run. Eligibility is judged against
 * the analysis version of this candidate (prompt version + profile fingerprint).
 */
export function planAnalyses(
  store: OpportunityStore,
  candidate: CandidateProfile,
  options: { limit: number; force?: boolean; only?: OpportunityKey },
): { keys: OpportunityKey[]; eligible: number } {
  const selection = store.analyses.select(analysisVersionFor(candidate), options);
  return { keys: selection.keys, eligible: selection.totalEligible };
}

/**
 * Analyzes pending open opportunities, newest first, one at a time, up to `limit`.
 * Each success is persisted immediately (so a later failure cannot lose it). A failed opportunity is
 * recorded and stays pending. Quota exhaustion or a rejected request ends the batch at once without
 * recording anything against the remaining opportunities; repeated outages end it too.
 */
export async function runAnalysisBatch(options: AnalysisBatchOptions): Promise<AnalysisBatchReport> {
  const { store, analyzer, candidate } = options;
  const now = options.now ?? (() => new Date());

  const version = analysisVersionFor(candidate);
  const { keys, eligible } = planAnalyses(store, candidate, {
    limit: options.limit,
    ...(options.force ? { force: true } : {}),
    ...(options.only ? { only: options.only } : {}),
  });
  const report: AnalysisBatchReport = {
    eligible,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    leftPending: eligible,
    stopReason: 'completed',
    stopDetail: null,
    failures: [],
    analyses: [],
  };

  let consecutiveUnavailable = 0;
  for (const key of keys) {
    const id = `${key.sourceId}:${key.externalId}`;
    const stored = store.get(key);
    if (!stored) continue;

    report.attempted += 1;
    try {
      const analysis = await analyzer.analyze({ opportunity: stored.opportunity, candidate, now: now() });
      store.analyses.save(analysis, { replace: options.force === true });
      report.succeeded += 1;
      report.analyses.push(analysis);
      consecutiveUnavailable = 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (error instanceof AnalysisQuotaError) {
        report.attempted -= 1;
        report.stopReason = 'quota-exhausted';
        report.stopDetail = message;
        break;
      }
      if (error instanceof AnalysisRejectedError) {
        report.attempted -= 1;
        report.stopReason = 'provider-rejected';
        report.stopDetail = message;
        break;
      }

      report.failed += 1;
      report.failures.push({ id, message });
      store.analyses.recordFailure({
        key,
        analysisVersion: version,
        provider: analyzer.id,
        model: analyzer.model,
        message,
        at: now().toISOString(),
      });

      if (error instanceof AnalysisUnavailableError) {
        consecutiveUnavailable += 1;
        if (consecutiveUnavailable >= MAX_CONSECUTIVE_UNAVAILABLE) {
          report.stopReason = 'provider-unavailable';
          report.stopDetail = message;
          break;
        }
      } else if (error instanceof AnalysisInvalidOutputError) {
        consecutiveUnavailable = 0;
      }
    }
  }

  report.leftPending = Math.max(0, eligible - report.succeeded);
  return report;
}
