import type { PipelineReport } from './run-pipeline.js';

/** Terminal lines for a collection run. Groups are disjoint, so nothing is counted twice. */
export function describeCollect(report: PipelineReport, requests: number): string[] {
  const lines = [
    `pages scanned         : ${report.pagesScanned}`,
    `summaries discovered  : ${report.discovered} = already known ${report.alreadyKnown} + new ${report.newSummaries} + already queued ${report.alreadyQueued}`,
    `details attempted     : ${report.detailsAttempted} = obtained ${report.detailsObtained} + failed (will retry) ${report.detailsFailed} + unavailable ${report.detailsUnavailable}`,
    `queue after the run   : pending ${report.queue.pending} | done ${report.queue.done} | unavailable ${report.queue.unavailable}`,
    `pagination stop       : ${report.stopReason}${report.stopDetail ? ` (${report.stopDetail})` : ''}`,
    `decisions (obtained)  : shortlist=${report.decisions.shortlist} review=${report.decisions.review} skip=${report.decisions.skip}`,
    `http requests to site : ${requests}`,
  ];
  for (const { opportunity, filter } of report.processed.filter((entry) => entry.filter.decision !== 'skip')) {
    lines.push(`  [${filter.decision.toUpperCase()}] ${opportunity.externalId} ${opportunity.title}`);
  }
  for (const failure of report.failures) lines.push(`  detail failed ${failure.externalId}: ${failure.message}`);
  if (report.aborted) lines.push(`Run stopped: the source blocked access (${report.aborted})`);
  return lines;
}
