import { config as loadDotenv } from 'dotenv';
import { loadConfig } from './config.js';
import { runPipeline, type PipelineReport, type ProcessedOpportunity } from './pipeline/run-pipeline.js';
import { donBrunoProfile } from './profile/don-bruno.js';
import { Freelas99Client } from './sources/99freelas/99freelas-client.js';
import { Freelas99Source } from './sources/99freelas/99freelas-source.js';
import { SourceBlockedError } from './sources/source-errors.js';
import { OpportunityStore } from './storage/opportunity-store.js';

async function main(): Promise<number> {
  loadDotenv({ quiet: true });
  const config = loadConfig();

  const client = new Freelas99Client();
  const source = new Freelas99Source(client);
  const store = new OpportunityStore(config.databasePath);

  try {
    console.log(`database: ${config.databasePath} (${store.count()} rows before this run)`);
    const report = await runPipeline({
      source,
      store,
      profile: donBrunoProfile,
      maxDetailsPerRun: config.maxDetailsPerRun,
    });
    printReport(report, client.requestCount, store.count());
    return report.aborted ? 2 : report.failures.length > 0 ? 1 : 0;
  } finally {
    store.close();
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
    if (error instanceof SourceBlockedError) {
      console.error(`Blocked by the source, stopping without retry: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
