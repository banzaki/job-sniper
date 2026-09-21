import type { InterestProfile } from '../profile/interest-profile.js';
import type { SourceRun } from '../sources/create-sources.js';
import { SourceBlockedError } from '../sources/source-errors.js';
import type { OpportunityStore } from '../storage/opportunity-store.js';
import { describeCollect } from './format-report.js';
import { runPipeline, type PipelineReport } from './run-pipeline.js';

export interface SourceOutcome {
  name: string;
  report: PipelineReport | null;
  /** Set when the whole source failed before producing a report. */
  error: string | null;
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Collects each enabled source in turn, every one with its own limits. A failure or a block in one source is
 * reported and never stops the next one. Exit code: 2 when a source blocked us, 1 for other failures, else 0.
 */
export async function collectSources(
  runs: readonly SourceRun[],
  store: OpportunityStore,
  profile: InterestProfile,
  log: (line: string) => void = console.log,
): Promise<{ exitCode: number; outcomes: SourceOutcome[] }> {
  let exitCode = 0;
  const outcomes: SourceOutcome[] = [];
  for (const run of runs) {
    if (runs.length > 1) log(`\n-- source: ${run.label} --`);
    try {
      const report = await runPipeline({ source: run.source, store, profile, ...run.limits });
      for (const line of [...describeCollect(report, run.requestCount()), ...run.notes()]) log(line);
      outcomes.push({ name: run.name, report, error: null });
      if (report.aborted) exitCode = 2;
      else if (report.stopReason === 'source-error') exitCode = Math.max(exitCode, 1);
    } catch (error) {
      const blocked = error instanceof SourceBlockedError;
      log(blocked ? `Blocked by ${run.label}, stopping its collection without retry: ${reason(error)}` : `Collection from ${run.label} failed: ${reason(error)}`);
      for (const line of run.notes()) log(line);
      outcomes.push({ name: run.name, report: null, error: reason(error) });
      exitCode = blocked ? 2 : Math.max(exitCode, 1);
    }
  }
  return { exitCode, outcomes };
}
