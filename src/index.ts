import { describeQuotaUsage, describeStage, describePlan } from './ai/format-report.js';
import { planAnalyses } from './ai/analysis-batch.js';
import { runAiStage } from './ai/ai-stage.js';
import { createAnalyzer } from './ai/create-analyzer.js';
import { AI_SOURCE_IDS, ANALYSIS_VERSION } from './ai/current-version.js';
import { loadAiConfig, loadAppConfig } from './config.js';
import { FILTER_RULE_VERSION } from './filter/opportunity-filter.js';
import { createNotifier } from './notify/create-notifier.js';
import { printNotifyReport } from './notify/format-report.js';
import { notifyPending } from './notify/notify-pending.js';
import { SOURCE_LABELS } from './notify/source-labels.js';
import { SOURCE_DATA_MAX_AGE_HOURS } from './sources/create-sources.js';
import { collectSources } from './pipeline/collect-sources.js';
import { describeAlertBatch, selectAlertBatch, type AlertBatchReport } from './pipeline/select-alert-batch.js';
import { reevaluateOutdated } from './pipeline/reevaluate.js';
import { brunoCandidate } from './profile/bruno-candidate.js';
import { donBrunoProfile } from './profile/don-bruno.js';
import { createSourceRuns } from './sources/create-sources.js';
import { OpportunityStore } from './storage/opportunity-store.js';

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * One full pass, as three independent stages: collect (discovery + details), AI analysis, and delivery of the
 * saved analyses. A problem in one stage (blocked source, exhausted AI quota, an error) is reported and never
 * prevents the next stage from running on what is already stored.
 */
async function main(): Promise<number> {
  // The collection is identified by the instant the run starts: what it stores for the first time competes for THIS run's alerts.
  const runStartedAt = new Date().toISOString();
  const config = loadAppConfig();
  // Validates Telegram credentials (when DRY_RUN=false) before any request is made.
  const notifier = createNotifier(config);
  const ai = loadAiConfig();

  const store = new OpportunityStore(config.databasePath);
  let exitCode = 0;

  try {
    // Fail fast on a missing Gemini key, before anything else happens (only outside dry-run).
    const analyzer = ai.enabled && !config.dryRun ? createAnalyzer(ai, store) : null;

    console.log(
      `database: ${config.databasePath} (${store.count()} rows before this run) | ` +
        (config.dryRun ? 'mode: DRY_RUN (nothing is sent or marked as notified)' : 'mode: LIVE (Telegram)'),
    );

    const discarded = store.analyses.discardSuperseded(ANALYSIS_VERSION, new Date().toISOString());
    if (discarded > 0) console.log(`discarded ${discarded} proposal draft(s) produced under an earlier analysis version`);
    const reevaluation = reevaluateOutdated(store, donBrunoProfile);
    console.log(`re-evaluated stored opportunities to ${FILTER_RULE_VERSION}: ${reevaluation.reevaluated}`);
    if (reevaluation.failures.length > 0) exitCode = 1;

    // ---- stage 1: collect ----
    console.log('\n== collect ==');
    try {
      // Each enabled source runs with its own limits; one failing never stops the next.
      const collected = await collectSources(createSourceRuns(config, store), store, donBrunoProfile);
      exitCode = Math.max(exitCode, collected.exitCode);
    } catch (error) {
      console.error(`Collection failed: ${reason(error)}`);
      exitCode = Math.max(exitCode, 1);
    }

    // ---- the alert batch of this collection: persisted before anything is sent ----
    let batch: AlertBatchReport | null = null;
    try {
      batch = selectAlertBatch(store, { batchId: runStartedAt, decisions: config.notifyDecisions, cap: config.maxTelegramAlertsPerRun, maxAgeHoursBySource: SOURCE_DATA_MAX_AGE_HOURS, now: new Date() });
      for (const line of describeAlertBatch(batch)) console.log(line);
    } catch (error) {
      console.error(`Alert batch selection failed (nothing new will be alerted in this run): ${reason(error)}`);
      exitCode = Math.max(exitCode, 1);
    }

    // ---- stage 2: AI analysis (its failure or quota never blocks stage 3) ----
    console.log('\n== ai ==');
    try {
      if (!ai.enabled) {
        console.log('ai analysis: disabled (AI_ENABLED is not "true")');
      } else if (!analyzer) {
        for (const line of describePlan(planAnalyses(store, brunoCandidate, { limit: ai.maxAnalysesPerRun, sourceIds: AI_SOURCE_IDS }))) console.log(line);
      } else {
        const stage = await runAiStage({ store, analyzer, candidate: brunoCandidate, limit: ai.maxAnalysesPerRun, sourceIds: AI_SOURCE_IDS });
        for (const line of describeStage(stage, analyzer.id, analyzer.model)) console.log(line);
        if (stage.status === 'ran' && (stage.batch.stopReason !== 'completed' || stage.batch.failed > 0)) exitCode = Math.max(exitCode, 1);
      }
      if (ai.enabled) for (const line of describeQuotaUsage(store, ai.provider, ai.model, ai.maxRequestsPerDay, new Date())) console.log(line);
    } catch (error) {
      console.error(`AI stage failed (delivery of saved analyses continues): ${reason(error)}`);
      exitCode = Math.max(exitCode, 1);
    }

    // ---- stage 3: deliver ----
    console.log('\n== notify ==');
    try {
      const notification = await notifyPending({
        store,
        notifier,
        decisions: config.notifyDecisions,
        dryRun: config.dryRun,
        analysisVersion: ANALYSIS_VERSION,
        candidate: brunoCandidate,
        format: { sourceLabels: SOURCE_LABELS },
        maxAgeHoursBySource: SOURCE_DATA_MAX_AGE_HOURS,
        maxAlerts: config.maxTelegramAlertsPerRun,
        // Only the batch may receive a first notification. The old backlog is delivered on purpose, by "npm run backlog".
        alertKeys: batch?.alertKeys ?? [],
      });
      printNotifyReport(notification, config.notifyDecisions.join(','), config.dryRun);
      if (notification.failures.length > 0) exitCode = Math.max(exitCode, 1);
    } catch (error) {
      console.error(`Notification stage failed: ${reason(error)}`);
      exitCode = Math.max(exitCode, 1);
    }
    return exitCode;
  } finally {
    store.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(reason(error));
    process.exitCode = 1;
  },
);
