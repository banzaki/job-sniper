import { loadAppConfig } from '../config.js';
import { collectSources } from '../pipeline/collect-sources.js';
import { donBrunoProfile } from '../profile/don-bruno.js';
import { createSourceRuns } from '../sources/create-sources.js';
import { OpportunityStore } from '../storage/opportunity-store.js';

/**
 * Collection only: discovery into the persistent queue, then details. No AI and no notifications, so
 * it can be run (and limited, through DISCOVERY_* and MAX_DETAILS_PER_RUN) on its own.
 */
async function main(): Promise<number> {
  const config = loadAppConfig();
  const store = new OpportunityStore(config.databasePath);
  try {
    const runs = createSourceRuns(config, store);
    console.log(
      `database: ${config.databasePath} | sources: ${runs.map((run) => run.name).join(', ')} | 99freelas limits: pages ${config.discoveryMaxPages}, new summaries ${config.discoveryTargetNew}, details ${config.maxDetailsPerRun}`,
    );
    return (await collectSources(runs, store, donBrunoProfile)).exitCode;
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
