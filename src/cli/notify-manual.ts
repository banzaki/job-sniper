import { ANALYSIS_VERSION } from '../ai/current-version.js';
import { loadAppConfig } from '../config.js';
import { createNotifier } from '../notify/create-notifier.js';
import { describeDailyAllowance } from '../notify/daily-limit.js';
import { deliverManual } from '../notify/manual.js';
import { parseManualArgs } from '../notify/manual-args.js';
import { SOURCE_LABELS } from '../notify/source-labels.js';
import { brunoCandidate } from '../profile/bruno-candidate.js';
import { SOURCE_DATA_MAX_AGE_HOURS } from '../sources/create-sources.js';
import { OpportunityStore } from '../storage/opportunity-store.js';

const USAGE = 'Usage: npm run notify:manual -- --only <source>:<id> [--send]';

/**
 * The REAL delivery, by hand, of ONE opportunity that was never delivered. It ignores only the automatic daily limit
 * (MAX_TELEGRAM_ALERTS_PER_DAY); it still requires a deliverable decision, a valid link, real content, fresh data and Telegram
 * credentials, and it records the delivery and notified_at only when Telegram confirms. An opportunity already delivered is not
 * sent again (use notify:preview to see it). Exactly one opportunity, never a batch. Without --send nothing is sent or marked.
 */
async function main(): Promise<number> {
  const { key, send } = parseManualArgs(process.argv.slice(2), USAGE);
  const config = loadAppConfig();
  // --send is the owner's explicit request: it does not depend on DRY_RUN, but Telegram credentials are still required.
  const notifier = createNotifier({ ...config, dryRun: !send });
  const store = new OpportunityStore(config.databasePath);
  try {
    console.log(`manual delivery of ${key.sourceId}:${key.externalId} | ${send ? 'mode: SEND (Telegram)' : 'mode: render only (add --send to send it)'} | the automatic daily limit is not applied`);
    const report = await deliverManual({
      store,
      notifier,
      key,
      send,
      decisions: config.notifyDecisions,
      analysisVersion: ANALYSIS_VERSION,
      candidate: brunoCandidate,
      format: { sourceLabels: SOURCE_LABELS, displayCurrency: config.displayCurrency },
      maxAgeHoursBySource: SOURCE_DATA_MAX_AGE_HOURS,
      dailyCap: config.maxTelegramAlertsPerDay,
    });
    if (report.daily) console.log(describeDailyAllowance(report.daily));
    if (report.outcome === 'sent') console.log('delivered and recorded (notified_at written after Telegram confirmed).');
    else if (report.outcome === 'rendered') console.log('Nothing was sent, stored or marked.');
    else console.error(`${report.outcome === 'refused' ? 'not delivered' : 'failed'}: ${report.reason ?? 'unknown'}`);
    return report.outcome === 'refused' || report.outcome === 'failed' ? 1 : 0;
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
