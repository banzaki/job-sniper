import { ConfigError, requireGeminiKey, type AiConfig } from '../config.js';
import type { OpportunityStore } from '../storage/opportunity-store.js';
import type { OpportunityAnalyzer } from './analyzer.js';
import { GeminiAnalyzer } from './gemini-analyzer.js';
import { QuotaGate } from './quota.js';

/**
 * Builds the configured analyzer. There is exactly one provider per run: no fallback to another
 * provider or model, ever. The API key is validated here, before any request is made. Every request
 * passes the quota gate (daily limit, cooldown, 15 s pacing) backed by the database.
 */
export function createAnalyzer(config: AiConfig, store: OpportunityStore): OpportunityAnalyzer {
  switch (config.provider) {
    case 'gemini': {
      const minIntervalMs = config.minIntervalSeconds * 1000;
      const gate = new QuotaGate(store, {
        provider: 'gemini',
        model: config.model,
        dailyLimit: config.maxRequestsPerDay,
        minIntervalMs,
      });
      return new GeminiAnalyzer(requireGeminiKey(config), config.model, { minIntervalMs, gate });
    }
    default:
      throw new ConfigError(`AI_PROVIDER "${config.provider}" is not supported. Only "gemini" is available.`);
  }
}
