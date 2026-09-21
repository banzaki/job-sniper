import { loadAppConfig } from '../config.js';
import { collectSources } from '../pipeline/collect-sources.js';
import { describeAlertBatch, selectAlertBatch } from '../pipeline/select-alert-batch.js';
import { donBrunoProfile } from '../profile/don-bruno.js';
import { createSourceRuns, SOURCE_DATA_MAX_AGE_HOURS } from '../sources/create-sources.js';
import { OpportunityStore } from '../storage/opportunity-store.js';

/**
 * Collection only: discovery into the persistent queue, then details, then the alert batch of the collection (recorded, not
 * sent). No AI and no notifications, so
 * it can be run (and limited, through DISCOVERY_* and MAX_DETAILS_PER_RUN) on its own.
 */
async function main(): Promise<number> {
  const runStartedAt = new Date().toISOString();
  const config = loadAppConfig();
  const store = new OpportunityStore(config.databasePath);
  try {
    const runs = createSourceRuns(config, store);
    console.log(
      `database: ${config.databasePath} | sources: ${runs.map((run) => run.name).join(', ')} | 99freelas limits: pages ${config.discoveryMaxPages}, new summaries ${config.discoveryTargetNew}, details ${config.maxDetailsPerRun}`,
    );
    const collected = await collectSources(runs, store, donBrunoProfile);
    // The best new opportunities of this collection are recorded as owed (nothing is sent here); the next full run delivers them.
    const batch = selectAlertBatch(store, { batchId: runStartedAt, decisions: config.notifyDecisions, cap: config.maxTelegramAlertsPerRun, maxAgeHoursBySource: SOURCE_DATA_MAX_AGE_HOURS, now: new Date() });
    for (const line of describeAlertBatch(batch)) console.log(line);
    return collected.exitCode;
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
