import { ANALYSIS_VERSION } from '../ai/current-version.js';
import { ConfigError, loadAppConfig } from '../config.js';
import type { MatchAnalysis } from '../domain/match-analysis.js';
import { formatAnalysisMessage } from '../notify/format-message.js';
import { OpportunityStore } from '../storage/opportunity-store.js';

const USAGE = 'Usage: npm run analyses -- [--proposals] [--messages]';
const GROUPS: readonly MatchAnalysis['recommendation'][] = ['apply', 'wait', 'review', 'skip'];
const SOURCE_LABELS = { '99freelas': '99Freelas' };

/** Shows stored AI analyses grouped by recommendation. Read-only: no network, no notifications. */
function main(): number {
  const flags = new Set(process.argv.slice(2));
  for (const flag of flags) {
    if (flag !== '--proposals' && flag !== '--messages') throw new ConfigError(`Unknown argument "${flag}". ${USAGE}`);
  }
  const config = loadAppConfig();
  const store = new OpportunityStore(config.databasePath);
  try {
    const discarded = store.analyses.discardSuperseded(ANALYSIS_VERSION, new Date().toISOString());
    const counts = store.analyses.counts(ANALYSIS_VERSION);
    console.log(
      `database: ${config.databasePath} | analysis version ${ANALYSIS_VERSION} | ` +
        `success=${counts.success} failed=${counts.failed} pending=${counts.pending}`,
    );
    console.log(
      `superseded (earlier prompt/profile, kept as history, not for use): ${store.analyses.countSuperseded(ANALYSIS_VERSION)}` +
        (discarded > 0 ? ` (discarded ${discarded} proposal draft(s) now)` : ''),
    );

    const stored = store.analyses
      .list(ANALYSIS_VERSION, 'success')
      .map((row) => store.analyses.get(row.key, ANALYSIS_VERSION))
      .filter((entry) => entry !== null);

    for (const group of GROUPS) {
      const items = stored.filter((entry) => entry.analysis.recommendation === group);
      console.log(`\n== ${group.toUpperCase()} (${items.length}) ==`);
      for (const { analysis, notifiedAt } of items) {
        const opportunity = store.get(analysis);
        console.log(`- ${opportunity?.opportunity.title ?? `${analysis.sourceId}:${analysis.externalId}`}`);
        console.log(
          `    ${analysis.recommendation} | fit ${analysis.score}/100, technical fit not a success probability (${analysis.confidence}) | skills: ${analysis.verification.status} | ai-notification: ${
            notifiedAt ? `sent ${notifiedAt}` : group === 'skip' ? 'not eligible' : 'pending'
          } | basic filter: ${opportunity?.filter.decision ?? 'n/a'}`,
        );
        console.log(`    access  : ${analysis.actionability.status} - ${analysis.actionability.reason}`);
        console.log(
          `    effort ${analysis.effort.minHours}-${analysis.effort.maxHours} h, ${analysis.complexity} | ` +
            `R$ ${analysis.price.min}-${analysis.price.max} | model ${analysis.model}${analysis.modelVersion ? ` (${analysis.modelVersion})` : ''}`,
        );
        console.log(`    fit     : ${analysis.technicalFit}`);
        if (opportunity) console.log(`    url     : ${opportunity.opportunity.url}`);
        if (flags.has('--proposals')) console.log(`    proposal (${analysis.proposal.language}, ${analysis.proposal.status}):\n${indent(analysis.proposal.text)}`);
        if (flags.has('--messages') && opportunity) {
          console.log('    --- Telegram message (rendered, not sent) ---');
          console.log(
            indent(formatAnalysisMessage(opportunity.opportunity, opportunity.filter, analysis, notifiedAt ? 'update' : 'enriched', { sourceLabels: SOURCE_LABELS })),
          );
        }
      }
    }

    const failed = store.analyses.list(ANALYSIS_VERSION, 'failed');
    console.log(`\n== FAILED (${failed.length}) - stay pending and are retried by the next run ==`);
    for (const row of failed) {
      console.log(`- ${row.key.sourceId}:${row.key.externalId} attempts=${row.attempts} last=${row.attemptedAt}`);
      console.log(`    ${row.errorMessage ?? 'no message'}`);
    }
    return 0;
  } finally {
    store.close();
  }
}

function indent(text: string): string {
  return text.split('\n').map((line) => `      ${line}`).join('\n');
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
