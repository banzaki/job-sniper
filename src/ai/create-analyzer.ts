import { ConfigError, requireGeminiKey, type AiConfig } from '../config.js';
import type { OpportunityAnalyzer } from './analyzer.js';
import { GeminiAnalyzer } from './gemini-analyzer.js';

/**
 * Builds the configured analyzer. There is exactly one provider per run: no fallback to another
 * provider or model, ever. The API key is validated here, before any request is made.
 */
export function createAnalyzer(config: AiConfig): OpportunityAnalyzer {
  switch (config.provider) {
    case 'gemini':
      return new GeminiAnalyzer(requireGeminiKey(config), config.model);
    default:
      throw new ConfigError(`AI_PROVIDER "${config.provider}" is not supported. Only "gemini" is available.`);
  }
}
