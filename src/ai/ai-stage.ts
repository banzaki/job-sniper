import type { CandidateProfile } from '../profile/candidate-profile.js';
import type { OpportunityKey } from '../domain/opportunity.js';
import type { OpportunityStore } from '../storage/opportunity-store.js';
import type { OpportunityAnalyzer } from './analyzer.js';
import { runAnalysisBatch, type AnalysisBatchReport } from './analysis-batch.js';
import { realClock, withLock, type Clock } from './quota.js';

/** A run holds this lock while it talks to the provider; a crashed run's lock is recovered (see withLock). */
const LOCK_TTL_MS = 30 * 60_000;

export interface AiStageOptions {
  store: OpportunityStore;
  analyzer: OpportunityAnalyzer;
  candidate: CandidateProfile;
  limit: number;
  force?: boolean;
  only?: OpportunityKey;
  clock?: Clock;
  isAlive?: (pid: number) => boolean;
  pid?: number;
}

export type AiStageResult =
  | { status: 'ran'; batch: AnalysisBatchReport; recoveredLock: boolean }
  | { status: 'paused'; until: string; kind: string | null; reason: string | null }
  | { status: 'locked'; heldByPid: number; expiresAt: string };

/**
 * The whole AI step: skips (without any request) while a cooldown from an earlier quota refusal is active,
 * refuses to overlap another run, and otherwise analyzes. The outcome never affects collection or the delivery
 * of analyses that are already saved: those are separate steps.
 */
export async function runAiStage(options: AiStageOptions): Promise<AiStageResult> {
  const { store, analyzer } = options;
  const clock = options.clock ?? realClock;

  const state = store.quota.state(analyzer.id, analyzer.model);
  if (state?.cooldownUntil && Date.parse(state.cooldownUntil) > clock.now()) {
    return { status: 'paused', until: state.cooldownUntil, kind: state.cooldownKind, reason: state.cooldownReason };
  }

  const locked = await withLock(
    store,
    {
      name: `ai:${analyzer.id}:${analyzer.model}`,
      owner: `${options.pid ?? process.pid}-${clock.now()}`,
      pid: options.pid ?? process.pid,
      ttlMs: LOCK_TTL_MS,
      clock,
      ...(options.isAlive ? { isAlive: options.isAlive } : {}),
    },
    () =>
      runAnalysisBatch({
        store,
        analyzer,
        candidate: options.candidate,
        limit: options.limit,
        now: () => new Date(clock.now()),
        ...(options.force ? { force: true } : {}),
        ...(options.only ? { only: options.only } : {}),
      }),
  );
  if (!locked.acquired) return { status: 'locked', heldByPid: locked.heldByPid, expiresAt: locked.expiresAt };
  return { status: 'ran', batch: locked.result, recoveredLock: locked.recovered };
}
