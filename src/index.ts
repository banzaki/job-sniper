import { planAnalyses, runAnalysisBatch } from './ai/analysis-batch.js';
import { createAnalyzer } from './ai/create-analyzer.js';
import { ANALYSIS_VERSION } from './ai/current-version.js';
import { describeBatch, describePlan } from './ai/format-report.js';
import { loadAiConfig, loadAppConfig } from './config.js';
import { FILTER_RULE_VERSION } from './filter/opportunity-filter.js';
import { createNotifier } from './notify/create-notifier.js';
import { notifyPending, type NotifyReport } from './notify/notify-pending.js';
import { reevaluateOutdated } from './pipeline/reevaluate.js';
import { runPipeline, type PipelineReport, type ProcessedOpportunity } from './pipeline/run-pipeline.js';
import { brunoCandidate } from './profile/bruno-candidate.js';
import { donBrunoProfile } from './profile/don-bruno.js';
import { Freelas99Client } from './sources/99freelas/99freelas-client.js';
import { Freelas99Source } from './sources/99freelas/99freelas-source.js';
import { SourceBlockedError } from './sources/source-errors.js';
import { OpportunityStore } from './storage/opportunity-store.js';

const SOURCE_LABELS = { '99freelas': '99Freelas' };

async function main(): Promise<number> {
  const config = loadAppConfig();
  // Validates Telegram credentials (when DRY_RUN=false) before any request is made.
  const notifier = createNotifier(config);
  // AI settings are read on their own; a real analyzer (and its API key) is needed only outside dry-run.
  const ai = loadAiConfig();
  const analyzer = ai.enabled && !config.dryRun ? createAnalyzer(ai) : null;

  const client = new Freelas99Client();
  const source = new Freelas99Source(client);
  const store = new OpportunityStore(config.databasePath);
  let exitCode = 0;

  try {
    console.log(
      `database: ${config.databasePath} (${store.count()} rows before this run) | ` +
        (config.dryRun ? 'mode: DRY_RUN (nothing is sent or marked as notified)' : 'mode: LIVE (Telegram)'),
    );

    // Proposals from an older prompt or an older candidate profile must not be used: mark them discarded (history stays).
    const discarded = store.analyses.discardSuperseded(ANALYSIS_VERSION, new Date().toISOString());
    if (discarded > 0) console.log(`discarded ${discarded} proposal draft(s) produced under an earlier analysis version`);

    const reevaluation = reevaluateOutdated(store, donBrunoProfile);
    console.log(`re-evaluated stored opportunities to ${FILTER_RULE_VERSION}: ${reevaluation.reevaluated}`);
    if (reevaluation.failures.length > 0) exitCode = 1;

    // A collection problem must not stop notifications for what is already stored.
    try {
      const report = await runPipeline({
        source,
        store,
        profile: donBrunoProfile,
        maxDetailsPerRun: config.maxDetailsPerRun,
        maxPages: config.discoveryMaxPages,
        targetNew: config.discoveryTargetNew,
      });
      printReport(report, client.requestCount, store.count());
      if (report.aborted) exitCode = 2;
      else if (report.failures.length > 0 || report.stopReason === 'source-error') exitCode = 1;
    } catch (error) {
      const blocked = error instanceof SourceBlockedError;
      console.error(
        blocked
          ? `Blocked by the source, stopping collection without retry: ${error.message}`
          : `Collection failed: ${error instanceof Error ? error.message : error}`,
      );
      exitCode = blocked ? 2 : 1;
    }

    // AI analysis of pending open opportunities, newest first. Failures stay pending and never stop notifications.
    console.log('');
    if (!ai.enabled) {
      console.log('ai analysis: disabled (AI_ENABLED is not "true")');
    } else if (!analyzer) {
      for (const line of describePlan(planAnalyses(store, brunoCandidate, { limit: ai.maxAnalysesPerRun }))) console.log(line);
    } else {
      const batch = await runAnalysisBatch({ store, analyzer, candidate: brunoCandidate, limit: ai.maxAnalysesPerRun });
      for (const line of describeBatch(batch, analyzer.id, analyzer.model)) console.log(line);
      if (batch.stopReason !== 'completed' || batch.failed > 0) exitCode = Math.max(exitCode, 1);
    }

    const notification = await notifyPending({
      store,
      notifier,
      decisions: config.notifyDecisions,
      dryRun: config.dryRun,
      analysisVersion: ANALYSIS_VERSION,
      format: { sourceLabels: SOURCE_LABELS },
    });
    printNotifyReport(notification, config.notifyDecisions.join(','), config.dryRun);
    if (notification.failures.length > 0) exitCode = Math.max(exitCode, 1);
    return exitCode;
  } finally {
    store.close();
  }
}

function printNotifyReport(report: NotifyReport, decisions: string, dryRun: boolean): void {
  console.log('');
  console.log(`notifications (${decisions}): pending=${report.pending} ${dryRun ? `rendered=${report.rendered} (dry-run, none sent, none marked)` : `sent=${report.sent}`} failures=${report.failures.length}`);
  console.log(
    `  basic=${report.kinds.basic} ai-enriched=${report.kinds.enriched} ai-update=${report.kinds.aiUpdate} ` +
      `withheld (AI skip)=${report.suppressedBySkip}`,
  );
  for (const failure of report.failures) {
    console.error(`  not notified ${failure.id}: ${failure.message}`);
  }
  if (report.aborted) {
    console.error('  Notification stopped early; remaining items stay pending for the next run.');
  }
}

function printReport(report: PipelineReport, requests: number, rowsAfter: number): void {
  console.log('');
  console.log(`pages scanned       : ${report.pagesScanned}`);
  console.log(`summaries discovered: ${report.discovered}`);
  console.log(`already known       : ${report.alreadyKnown}`);
  console.log(`unseen collected    : ${report.unseenCollected}`);
  console.log(`details requested   : ${report.detailsRequested}`);
  console.log(`deferred (limit)    : ${report.deferred}`);
  console.log(`pagination stop     : ${report.stopReason}${report.stopDetail ? ` (${report.stopDetail})` : ''}`);
  console.log(`persisted           : ${report.persisted}`);
  console.log(
    `decisions           : shortlist=${report.decisions.shortlist} review=${report.decisions.review} skip=${report.decisions.skip}`,
  );
  console.log(`failures            : ${report.failures.length}`);
  console.log(`http requests       : ${requests}`);
  console.log(`database rows       : ${rowsAfter}`);

  for (const decision of ['shortlist', 'review'] as const) {
    for (const item of report.processed.filter((entry) => entry.filter.decision === decision)) {
      printCandidate(item);
    }
  }
  const skipped = report.processed.filter((entry) => entry.filter.decision === 'skip');
  if (skipped.length > 0) {
    console.log('\nskipped:');
    for (const { opportunity, filter } of skipped) {
      console.log(`- ${opportunity.externalId} ${opportunity.title} :: ${filter.reasons.join('; ')}`);
    }
  }
  if (report.failures.length > 0) {
    console.log('\nfailures:');
    for (const failure of report.failures) {
      console.log(`- ${failure.externalId}: ${failure.message}`);
    }
  }
  if (report.aborted) {
    console.error(`\nRun stopped: the source blocked access (${report.aborted})`);
  }
}

function printCandidate({ opportunity, filter }: ProcessedOpportunity): void {
  console.log('');
  console.log(`[${filter.decision.toUpperCase()}] ${opportunity.title}`);
  console.log(`  reasons : ${filter.reasons.join('; ')}`);
  console.log(`  keywords: ${filter.matchedKeywords.join(', ') || '-'}`);
  console.log(`  status  : ${opportunity.status}`);
  console.log(`  category: ${opportunity.category ?? 'n/a'} / ${opportunity.subcategory ?? 'n/a'}`);
  console.log(`  url     : ${opportunity.url}`);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
