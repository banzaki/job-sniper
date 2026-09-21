import type { AnalysisBatchReport } from './analysis-batch.js';

/** Terminal lines for an analysis batch. Never includes descriptions, proposals or any secret. */
export function describeBatch(report: AnalysisBatchReport, provider: string, model: string): string[] {
  const lines = [
    `ai analysis (${provider} / ${model}): eligible=${report.eligible} attempted=${report.attempted} ` +
      `succeeded=${report.succeeded} failed=${report.failed} left pending=${report.leftPending} stop=${report.stopReason}`,
  ];
  if (report.stopDetail) lines.push(`  stop detail: ${report.stopDetail}`);
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

export function describePlan(plan: { keys: { sourceId: string; externalId: string }[]; eligible: number }): string[] {
  return [
    `ai analysis (dry-run): would analyze ${plan.keys.length} of ${plan.eligible} pending opportunities; no AI provider is called`,
    ...plan.keys.map((key) => `  ${key.sourceId}:${key.externalId}`),
  ];
}
