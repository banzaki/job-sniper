import { ANALYSIS_VERSION } from '../ai/current-version.js';
import { ConfigError, loadAppConfig } from '../config.js';
import type { OpportunityKey } from '../domain/opportunity.js';
import { createNotifier } from '../notify/create-notifier.js';
import { notifyPending } from '../notify/notify-pending.js';
import { OpportunityStore } from '../storage/opportunity-store.js';

const USAGE = 'Usage: npm run notify:analyses -- --only <sourceId:externalId>[,<sourceId:externalId>...] (repeatable)';
const SOURCE_LABELS = { '99freelas': '99Freelas' };

function parseOnly(argv: readonly string[]): OpportunityKey[] {
  const keys: OpportunityKey[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--only') throw new ConfigError(`Unknown argument "${argv[index]}". ${USAGE}`);
    for (const raw of (argv[++index] ?? '').split(',').map((part) => part.trim()).filter(Boolean)) {
      const separator = raw.indexOf(':');
      if (separator < 1 || separator === raw.length - 1) throw new ConfigError(`Invalid id "${raw}". ${USAGE}`);
      keys.push({ sourceId: raw.slice(0, separator), externalId: raw.slice(separator + 1) });
    }
  }
  if (keys.length === 0) throw new ConfigError(USAGE);
  return keys;
}

/**
 * Announces the AI analyses (current version) of the GIVEN opportunities only: no discovery, no analysis,
 * and no basic-filter notifications. Rules are the usual ones: a clear "skip" is never sent, each analysis
 * is announced once (its own notified_at), and nothing is marked in DRY_RUN or when delivery fails.
 */
async function main(): Promise<number> {
  const only = parseOnly(process.argv.slice(2));
  const config = loadAppConfig();
  const notifier = createNotifier(config);
  const store = new OpportunityStore(config.databasePath);
  try {
    console.log(`analysis version: ${ANALYSIS_VERSION} | ${only.length} id(s) | ${config.dryRun ? 'mode: DRY_RUN (nothing sent or marked)' : 'mode: LIVE (Telegram)'}`);
    const report = await notifyPending({
      store,
      notifier,
      decisions: [],
      dryRun: config.dryRun,
      analysisVersion: ANALYSIS_VERSION,
      only,
      format: { sourceLabels: SOURCE_LABELS },
    });
    console.log(
      `analysis notifications: pending=${report.pending} ${config.dryRun ? `rendered=${report.rendered}` : `sent=${report.sent}`} ` +
        `(ai-enriched=${report.kinds.enriched} ai-update=${report.kinds.aiUpdate}) failures=${report.failures.length}`,
    );
    for (const failure of report.failures) console.error(`  not notified ${failure.id}: ${failure.message}`);
    return report.failures.length > 0 ? 1 : 0;
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
