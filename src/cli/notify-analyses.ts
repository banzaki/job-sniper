import { SOURCE_LABELS } from '../notify/source-labels.js';
import { ANALYSIS_VERSION } from '../ai/current-version.js';
import { ConfigError, loadAppConfig } from '../config.js';
import type { OpportunityKey } from '../domain/opportunity.js';
import { createNotifier } from '../notify/create-notifier.js';
import { printNotifyReport } from '../notify/format-report.js';
import { notifyPending } from '../notify/notify-pending.js';
import { brunoCandidate } from '../profile/bruno-candidate.js';
import { OpportunityStore } from '../storage/opportunity-store.js';

const USAGE = 'Usage: npm run notify:analyses -- --only <sourceId:externalId>[,<sourceId:externalId>...] (repeatable)';

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
 * Delivers the AI analyses (current version) of the GIVEN opportunities only: no discovery, no analysis, and
 * no basic-filter notifications. A delivery is ONE compact message; an interrupted one resumes without
 * repeating what was confirmed. Deliveries of the former multi-part format are reported, never resumed. A clear "skip" is never sent, and nothing is marked in DRY_RUN or when delivery fails.
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
      candidate: brunoCandidate,
      format: { sourceLabels: SOURCE_LABELS },
    });
    printNotifyReport(report, 'analyses only', config.dryRun);
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
