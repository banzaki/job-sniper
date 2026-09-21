import { ANALYSIS_VERSION } from '../ai/current-version.js';
import { loadAppConfig } from '../config.js';
import { mainCaveat } from '../filter/caveats.js';
import { createNotifier } from '../notify/create-notifier.js';
import { printNotifyReport } from '../notify/format-report.js';
import { notifyPending } from '../notify/notify-pending.js';
import { SOURCE_LABELS } from '../notify/source-labels.js';
import { translateReason } from '../notify/translate-reasons.js';
import { pickBacklog, viewBacklog } from '../pipeline/backlog.js';
import { brunoCandidate } from '../profile/bruno-candidate.js';
import { SOURCE_DATA_MAX_AGE_HOURS } from '../sources/create-sources.js';
import { OpportunityStore } from '../storage/opportunity-store.js';

const MAX_MANUAL_SEND = 20;
const LIST_SIZE = 10;

function parseArgs(argv: readonly string[]): { send: boolean; limit: number | null } {
  let send = false;
  let limit: number | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--send') send = true;
    else if (arg === '--limit') {
      const value = argv[(i += 1)] ?? '';
      if (!/^[1-9]\d*$/.test(value) || Number(value) > MAX_MANUAL_SEND) throw new Error(`--limit must be a whole number from 1 to ${MAX_MANUAL_SEND}, but got "${value}".`);
      limit = Number(value);
    } else throw new Error(`Unknown argument "${String(arg)}". Use: npm run backlog [-- --send [--limit N]]`);
  }
  return { send, limit };
}

/**
 * The backlog: owed opportunities that no automatic alert will ever pick (older than the last batch, or beyond its cap).
 * By default it only LISTS them, best first. Sending is a deliberate act: `npm run backlog -- --send [--limit N]` sends the
 * best N (default: the per-run cap; at most 20), obeys DRY_RUN and the 24-hour data rule, and marks only what Telegram confirms.
 */
async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadAppConfig();
  const store = new OpportunityStore(config.databasePath);
  try {
    const now = new Date();
    const view = viewBacklog(store, config.notifyDecisions, { now, maxAgeHoursBySource: SOURCE_DATA_MAX_AGE_HOURS });
    const byDecision = new Map<string, number>();
    for (const { stored } of view.ready) byDecision.set(stored.filter.decision, (byDecision.get(stored.filter.decision) ?? 0) + 1);
    console.log(`database: ${config.databasePath} | backlog (owed, never selected for an automatic alert): ${view.total} | sendable now ${view.ready.length} (${[...byDecision].map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}) | too old to alert from ${view.stale}`);
    view.ready.slice(0, LIST_SIZE).forEach(({ key, stored }, index) => {
      const caveat = mainCaveat(stored.filter.reasons);
      console.log(`${String(index + 1).padStart(2)}. [${stored.filter.decision}] ${key.sourceId}:${key.externalId} | ${stored.opportunity.title.slice(0, 60)}${caveat ? ` | ${translateReason(caveat).slice(0, 70)}` : ''}`);
    });
    if (!args.send) {
      console.log('\nNothing was sent or changed. To send the best of them on purpose: npm run backlog -- --send --limit 5');
      return 0;
    }

    const limit = args.limit ?? Math.min(config.maxTelegramAlertsPerRun, MAX_MANUAL_SEND);
    const picks = pickBacklog(view, limit);
    console.log(`\nmanual send of the ${picks.length} best backlog item(s) (limit ${limit}) | mode: ${config.dryRun ? 'DRY_RUN (nothing is sent or marked)' : 'LIVE (Telegram)'}`);
    const notifier = createNotifier(config);
    const report = await notifyPending({
      store,
      notifier,
      decisions: config.notifyDecisions,
      dryRun: config.dryRun,
      analysisVersion: ANALYSIS_VERSION,
      candidate: brunoCandidate,
      format: { sourceLabels: SOURCE_LABELS },
      maxAgeHoursBySource: SOURCE_DATA_MAX_AGE_HOURS,
      maxAlerts: limit,
      only: picks,
      alertKeys: picks,
    });
    printNotifyReport(report, config.notifyDecisions.join(','), config.dryRun);
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
