import { loadAppConfig } from './config.js';
import { FILTER_RULE_VERSION } from './filter/opportunity-filter.js';
import { createNotifier } from './notify/create-notifier.js';
import { notifyPending, type NotifyReport } from './notify/notify-pending.js';
import { reevaluateOutdated } from './pipeline/reevaluate.js';
import { runPipeline, type PipelineReport, type ProcessedOpportunity } from './pipeline/run-pipeline.js';
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

  const client = new Freelas99Client();
  const source = new Freelas99Source(client);
  const store = new OpportunityStore(config.databasePath);
  let exitCode = 0;

  try {
    console.log(
      `database: ${config.databasePath} (${store.count()} rows before this run) | ` +
        (config.dryRun ? 'mode: DRY_RUN (nothing is sent or marked as notified)' : 'mode: LIVE (Telegram)'),
    );

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
      });
      printReport(report, client.requestCount, store.count());
      if (report.aborted) exitCode = 2;
      else if (report.failures.length > 0) exitCode = 1;
    } catch (error) {
      const blocked = error instanceof SourceBlockedError;
      console.error(
        blocked
          ? `Blocked by the source, stopping collection without retry: ${error.message}`
          : `Collection failed: ${error instanceof Error ? error.message : error}`,
      );
      exitCode = blocked ? 2 : 1;
    }

    const notification = await notifyPending({
      store,
      notifier,
      decisions: config.notifyDecisions,
      dryRun: config.dryRun,
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
  for (const failure of report.failures) {
    console.error(`  not notified ${failure.id}: ${failure.message}`);
  }
  if (report.aborted) {
    console.error('  Notification stopped early; remaining items stay pending for the next run.');
  }
}

function printReport(report: PipelineReport, requests: number, rowsAfter: number): void {
  console.log('');
  console.log(`listed              : ${report.listed}`);
  console.log(`already known       : ${report.alreadyKnown}`);
  console.log(`new                 : ${report.newFound}`);
  console.log(`deferred (limit)    : ${report.deferred}`);
  console.log(`details requested   : ${report.detailsRequested}`);
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
