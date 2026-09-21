import { runAiStage } from '../ai/ai-stage.js';
import { planAnalyses } from '../ai/analysis-batch.js';
import { createAnalyzer } from '../ai/create-analyzer.js';
import { ANALYSIS_VERSION } from '../ai/current-version.js';
import { describePlan, describeQuotaUsage, describeStage } from '../ai/format-report.js';
import { ConfigError, loadAiConfig, loadAppConfig } from '../config.js';
import type { OpportunityKey } from '../domain/opportunity.js';
import { brunoCandidate } from '../profile/bruno-candidate.js';
import { OpportunityStore } from '../storage/opportunity-store.js';

const USAGE = 'Usage: npm run ai:analyze -- [--limit N] [--only <sourceId:externalId>] [--force]';

interface Args {
  limit: number | null;
  only: OpportunityKey | null;
  force: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { limit: null, only: null, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--force') {
      args.force = true;
    } else if (flag === '--limit') {
      const raw = argv[++index] ?? '';
      if (!/^[1-9]\d*$/.test(raw)) throw new ConfigError(`--limit must be a positive integer. ${USAGE}`);
      args.limit = Number(raw);
    } else if (flag === '--only') {
      const raw = argv[++index] ?? '';
      const separator = raw.indexOf(':');
      if (separator < 1 || separator === raw.length - 1) throw new ConfigError(`--only needs <sourceId:externalId>. ${USAGE}`);
      args.only = { sourceId: raw.slice(0, separator), externalId: raw.slice(separator + 1) };
    } else {
      throw new ConfigError(`Unknown argument "${flag}". ${USAGE}`);
    }
  }
  return args;
}

/**
 * Analyzes pending opportunities with the configured AI provider. It does not touch the source site and does not
 * notify. Every request passes the quota gate; an active pause or another running AI step ends it without a request.
 */
async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadAppConfig();
  const ai = loadAiConfig();

  if (!ai.enabled) {
    console.log('AI is disabled (AI_ENABLED is not "true"). Nothing to do.');
    return 0;
  }
  const limit = Math.min(args.limit ?? ai.maxAnalysesPerRun, ai.maxAnalysesPerRun);
  const selection = { limit, ...(args.force ? { force: true } : {}), ...(args.only ? { only: args.only } : {}) };

  const store = new OpportunityStore(config.databasePath);
  try {
    const discarded = store.analyses.discardSuperseded(ANALYSIS_VERSION, new Date().toISOString());
    if (discarded > 0) console.log(`discarded ${discarded} proposal draft(s) produced under an earlier analysis version`);
    console.log(`analysis version: ${ANALYSIS_VERSION}`);

    if (config.dryRun) {
      for (const line of describePlan(planAnalyses(store, brunoCandidate, selection))) console.log(line);
      console.log('DRY_RUN=true: no AI provider was called and nothing was stored.');
      return 0;
    }

    const analyzer = createAnalyzer(ai, store);
    const stage = await runAiStage({ store, analyzer, candidate: brunoCandidate, ...selection });
    for (const line of describeStage(stage, analyzer.id, analyzer.model)) console.log(line);

    const counts = store.analyses.counts(ANALYSIS_VERSION);
    console.log(
      `totals for ${ANALYSIS_VERSION}: success=${counts.success} failed=${counts.failed} (exhausted ${counts.exhausted}) ` +
        `pending=${counts.pending} | basic-skip kept aside=${counts.keptAside}`,
    );
    for (const line of describeQuotaUsage(store, analyzer.id, analyzer.model, ai.maxRequestsPerDay, new Date())) console.log(line);
    if (stage.status !== 'ran') return 1;
    return stage.batch.stopReason !== 'completed' || stage.batch.failed > 0 ? 1 : 0;
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
