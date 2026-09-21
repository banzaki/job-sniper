import { ANALYSIS_VERSION } from '../ai/current-version.js';
import { loadAppConfig } from '../config.js';
import { createNotifier } from '../notify/create-notifier.js';
import { previewManual } from '../notify/manual.js';
import { parseManualArgs } from '../notify/manual-args.js';
import { SOURCE_LABELS } from '../notify/source-labels.js';
import { brunoCandidate } from '../profile/bruno-candidate.js';
import { SOURCE_DATA_MAX_AGE_HOURS } from '../sources/create-sources.js';
import { OpportunityStore } from '../storage/opportunity-store.js';

const USAGE = 'Usage: npm run notify:preview -- --only <source>:<id> [--send]';

/**
 * A manual preview ("🧪 PRÉVIA MANUAL") of ONE stored opportunity. Without --send it only prints the message. With --send it is
 * delivered to Telegram as a preview: it never changes notified_at, the alert queue or any production delivery, uses none of the
 * automatic daily limit, calls no AI and can be repeated any number of times. Exactly one opportunity, never a batch.
 */
async function main(): Promise<number> {
  const { key, send } = parseManualArgs(process.argv.slice(2), USAGE);
  const config = loadAppConfig();
  // --send is the owner's explicit request: it does not depend on DRY_RUN, but Telegram credentials are still required.
  const notifier = createNotifier({ ...config, dryRun: !send });
  const store = new OpportunityStore(config.databasePath);
  try {
    console.log(`preview of ${key.sourceId}:${key.externalId} | ${send ? 'mode: SEND (Telegram)' : 'mode: render only (add --send to send it)'}`);
    const report = await previewManual({
      store,
      notifier,
      key,
      send,
      analysisVersion: ANALYSIS_VERSION,
      candidate: brunoCandidate,
      format: { sourceLabels: SOURCE_LABELS, displayCurrency: config.displayCurrency },
      maxAgeHoursBySource: SOURCE_DATA_MAX_AGE_HOURS,
      print: (text) => console.log(`\n${text}\n`),
    });
    if (report.staleData) console.log('warning: the collected data is older than its source allows for an alert; this is only a preview, nothing else uses it.');
    if (report.failure) {
      console.error(`preview not delivered${report.failure.ambiguous ? ' (ambiguous: it may have reached Telegram)' : ''}: ${report.failure.message}`);
      return 1;
    }
    console.log(send ? 'preview delivered. notified_at, the alert queue and the automatic daily limit were not touched.' : 'Nothing was sent, stored or marked.');
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
