import { loadAppConfig } from '../config.js';
import { describeCollect } from '../pipeline/format-report.js';
import { runPipeline } from '../pipeline/run-pipeline.js';
import { donBrunoProfile } from '../profile/don-bruno.js';
import { Freelas99Client } from '../sources/99freelas/99freelas-client.js';
import { Freelas99Source } from '../sources/99freelas/99freelas-source.js';
import { OpportunityStore } from '../storage/opportunity-store.js';

/**
 * Collection only: discovery into the persistent queue, then details. No AI and no notifications, so
 * it can be run (and limited, through DISCOVERY_* and MAX_DETAILS_PER_RUN) on its own.
 */
async function main(): Promise<number> {
  const config = loadAppConfig();
  const client = new Freelas99Client();
  const store = new OpportunityStore(config.databasePath);
  try {
    console.log(
      `database: ${config.databasePath} | limits: pages ${config.discoveryMaxPages}, new summaries ${config.discoveryTargetNew}, details ${config.maxDetailsPerRun}`,
    );
    const report = await runPipeline({
      source: new Freelas99Source(client),
      store,
      profile: donBrunoProfile,
      maxDetailsPerRun: config.maxDetailsPerRun,
      maxPages: config.discoveryMaxPages,
      targetNew: config.discoveryTargetNew,
    });
    for (const line of describeCollect(report, client.requestCount)) console.log(line);
    if (report.aborted) return 2;
    return report.stopReason === 'source-error' ? 1 : 0;
  } finally {
    store.close();
  }
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
