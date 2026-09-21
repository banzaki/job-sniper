import { loadAppConfig } from '../config.js';
import type { FilterDecision } from '../domain/filter-result.js';
import { FILTER_RULE_VERSION } from '../filter/opportunity-filter.js';
import { reevaluateOutdated } from '../pipeline/reevaluate.js';
import { donBrunoProfile } from '../profile/don-bruno.js';
import type { AlertEntry } from '../storage/alert-queue-store.js';
import { OpportunityStore, type StoredOpportunity } from '../storage/opportunity-store.js';

const GROUPS: readonly FilterDecision[] = ['top_match', 'shortlist', 'review', 'skip'];

function main(): number {
  const config = loadAppConfig();
  const store = new OpportunityStore(config.databasePath);
  try {
    // Offline and idempotent: keeps decisions from going stale when the rule version changes.
    const reevaluation = reevaluateOutdated(store, donBrunoProfile);
    if (reevaluation.reevaluated > 0 || reevaluation.failures.length > 0) {
      const from = Object.entries(reevaluation.previousVersions).map(([version, n]) => `${version} x${n}`).join(', ');
      console.log(`re-evaluated ${reevaluation.reevaluated} stored opportunities (${from} -> ${FILTER_RULE_VERSION})`);
      for (const failure of reevaluation.failures) {
        console.log(`  could not re-evaluate ${failure.id}: ${failure.message}`);
      }
    }

    const stored: StoredOpportunity[] = [];
    for (const key of store.listKeys()) {
      try {
        const item = store.get(key);
        if (item) stored.push(item);
      } catch (error) {
        console.log(`  unreadable row ${key.sourceId}:${key.externalId}: ${error instanceof Error ? error.message : error}`);
      }
    }

    console.log(`database: ${config.databasePath} | ${stored.length} opportunities | rule ${FILTER_RULE_VERSION}`);
    for (const decision of GROUPS) {
      const group = stored.filter((item) => item.filter.decision === decision);
      console.log(`\n== ${decision.toUpperCase()} (${group.length}) ==`);
      for (const item of group) {
        printItem(item, config.notifyDecisions, store.alertQueue.get({ sourceId: item.opportunity.sourceId, externalId: item.opportunity.externalId }));
      }
    }
    return 0;
  } finally {
    store.close();
  }
}

function printItem(item: StoredOpportunity, notifyDecisions: readonly FilterDecision[], alert: AlertEntry | null): void {
  const { opportunity, filter } = item;
  const category = [opportunity.category, opportunity.subcategory].filter(Boolean).join(' / ') || 'n/a';
  console.log(`- ${opportunity.title}`);
  console.log(`    ${filter.decision} | status: ${opportunity.status} | notification: ${notification(item, notifyDecisions, alert)}`);
  console.log(`    reasons : ${filter.reasons.join('; ')}`);
  console.log(`    category: ${category}`);
  console.log(`    url     : ${opportunity.url}`);
}

function notification(item: StoredOpportunity, notifyDecisions: readonly FilterDecision[], alert: AlertEntry | null): string {
  if (item.notifiedAt) return `sent ${item.notifiedAt}`;
  if (!notifyDecisions.includes(item.filter.decision)) return 'not eligible';
  if (alert?.status === 'selected') return 'selected: owed until Telegram confirms it';
  if (alert?.status === 'expired') return 'selected once, data went stale: saved, not sent';
  return 'saved, not alerted automatically (backlog or beyond the cap): npm run backlog';
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
