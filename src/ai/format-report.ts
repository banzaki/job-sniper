import type { OpportunityStore } from '../storage/opportunity-store.js';
import type { AnalysisBatchReport } from './analysis-batch.js';
import type { AiStageResult } from './ai-stage.js';
import { quotaDayOf } from './quota.js';

/** Terminal lines for an analysis batch. Never includes descriptions, proposals or any secret. */
export function describeBatch(report: AnalysisBatchReport, provider: string, model: string): string[] {
  const lines = [
    `ai analysis (${provider} / ${model}): eligible=${report.eligible} attempted=${report.attempted} ` +
      `succeeded=${report.succeeded} failed=${report.failed} left pending=${report.leftPending} stop=${report.stopReason}`,
    `  requests: ${report.requests.total} (of which retries: ${report.requests.retries})`,
  ];
  if (report.stopDetail) lines.push(`  stop detail: ${report.stopDetail}`);
  if (report.cooldownUntil) lines.push(`  pause saved until: ${report.cooldownUntil}`);
  for (const analysis of report.analyses) {
    lines.push(
      `  ${analysis.recommendation.toUpperCase().padEnd(6)} ${String(analysis.score).padStart(3)}/100 ` +
        `${analysis.confidence.padEnd(6)} ${analysis.sourceId}:${analysis.externalId} model=${analysis.modelVersion ?? analysis.model}`,
    );
  }
  for (const failure of report.failures) {
    lines.push(`  failed ${failure.id}: ${failure.message}`);
  }
  return lines;
}

export function describeStage(result: AiStageResult, provider: string, model: string): string[] {
  switch (result.status) {
    case 'ran':
      return [
        ...(result.recoveredLock ? ['ai stage: recovered a lock left by a run that ended unexpectedly'] : []),
        ...describeBatch(result.batch, provider, model),
      ];
    case 'paused':
      return [
        `ai stage: paused until ${result.until}${result.reason ? ` (${result.reason})` : ''}; no request was made`,
      ];
    case 'locked':
      return [`ai stage: another AI run holds the lock (pid ${result.heldByPid}, until ${result.expiresAt}); nothing was done`];
  }
}

/** The app's own request counter for today's quota day. It is not the provider's balance. */
export function describeQuotaUsage(store: OpportunityStore, provider: string, model: string, dailyLimit: number, now: Date): string[] {
  const day = quotaDayOf(now);
  const used = store.quota.usage(provider, model, day);
  const state = store.quota.state(provider, model);
  const lines = [`local request counter (${model}, quota day ${day}, America/Los_Angeles): ${used} of ${dailyLimit}`];
  lines.push(
    state
      ? `  local control started ${state.trackingStartedAt}; consumption before that, or outside this app, is not included`
      : '  local control has not recorded any request yet; earlier or external consumption is unknown',
  );
  if (state?.cooldownUntil && Date.parse(state.cooldownUntil) > now.getTime()) {
    lines.push(`  pause active until ${state.cooldownUntil}${state.cooldownReason ? ` (${state.cooldownReason})` : ''}`);
  }
  return lines;
}

export function describePlan(plan: { keys: { sourceId: string; externalId: string }[]; eligible: number }): string[] {
  return [
    `ai analysis (dry-run): would analyze ${plan.keys.length} of ${plan.eligible} pending opportunities; no AI provider is called`,
    ...plan.keys.map((key) => `  ${key.sourceId}:${key.externalId}`),
  ];
}
