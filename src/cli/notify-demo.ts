import { SOURCE_LABELS } from '../notify/source-labels.js';
import { ANALYSIS_VERSION } from '../ai/current-version.js';
import { ConfigError, loadAppConfig } from '../config.js';
import type { OpportunityKey } from '../domain/opportunity.js';
import { deliverDemo } from '../notify/deliver.js';
import { createNotifier } from '../notify/create-notifier.js';
import { brunoCandidate } from '../profile/bruno-candidate.js';
import { OpportunityStore } from '../storage/opportunity-store.js';

const USAGE = 'Usage: npm run notify:demo -- --id <sourceId:externalId> [--label <name>]';

function parseArgs(argv: readonly string[]): { key: OpportunityKey; label: string } {
  let raw = '';
  let label = 'preview';
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--id') raw = argv[++index] ?? '';
    else if (argv[index] === '--label') label = argv[++index] ?? '';
    else throw new ConfigError(`Unknown argument "${argv[index]}". ${USAGE}`);
  }
  const separator = raw.indexOf(':');
  if (separator < 1 || separator === raw.length - 1) throw new ConfigError(USAGE);
  if (!/^[a-z0-9-]{1,40}$/i.test(label)) throw new ConfigError(`--label must be 1-40 letters, digits or hyphens. ${USAGE}`);
  return { key: { sourceId: raw.slice(0, separator), externalId: raw.slice(separator + 1) }, label };
}

/**
 * Sends ONE visual preview of a saved analysis (no AI call, no source access) as a delivery of its own.
 * It never changes notified_at of the opportunity or of the analysis. The same label is delivered once;
 * repeating it confirms no new part is sent.
 */
async function main(): Promise<number> {
  const { key, label } = parseArgs(process.argv.slice(2));
  const config = loadAppConfig();
  const notifier = createNotifier(config);
  const store = new OpportunityStore(config.databasePath);
  try {
    const report = await deliverDemo({
      store,
      notifier,
      key,
      analysisVersion: ANALYSIS_VERSION,
      label,
      dryRun: config.dryRun,
      candidate: brunoCandidate,
      sourceLabels: SOURCE_LABELS,
    });
    console.log(
      config.dryRun
        ? `demo (dry-run): ${report.rendered} part(s) rendered above; nothing sent, stored or marked`
        : `demo "${label}" for ${key.sourceId}:${key.externalId}: parts total=${report.totalParts} sent now=${report.partsSent} ` +
            `already confirmed=${report.partsAlreadyConfirmed} complete=${report.complete}`,
    );
    if (report.failure) {
      console.error(`  not delivered${report.failure.ambiguous ? ' (ambiguous: may have been delivered)' : ''}: ${report.failure.message}`);
      return 1;
    }
    return 0;
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
