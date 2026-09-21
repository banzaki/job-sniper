/** The model answered, but not with usable, valid, truthful output. Counted against that opportunity only. */
export class AnalysisInvalidOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisInvalidOutputError';
  }
}

/**
 * What a quota refusal tells us. Only what the evidence supports is named: "minute", "tokens" or "day" need
 * the provider's own quota identifier; otherwise the kind is "unknown". "local-day" and "cooldown" are refusals
 * made by this app before any request was sent.
 */
export interface QuotaInfo {
  kind: 'minute' | 'tokens' | 'day' | 'unknown' | 'local-day' | 'cooldown';
  retryAfterSeconds: number | null;
  /** Quota identifiers the provider returned, if any. */
  evidence: string[];
}

/** Quota or rate limit reached (HTTP 429). The remaining work stays pending; nothing is retried. */
export class AnalysisQuotaError extends Error {
  /** True when this app refused before sending anything (local daily limit or an active cooldown). */
  readonly local: boolean;

  constructor(message: string, readonly info: QuotaInfo | null = null, local = false) {
    super(message);
    this.name = 'AnalysisQuotaError';
    this.local = local;
  }
}

/** The provider refused the request itself (bad key, unknown model, malformed request). Not the opportunity's fault. */
export class AnalysisRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisRejectedError';
  }
}

/** Timeout, network failure or 5xx, still failing after the single bounded retry. */
export class AnalysisUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisUnavailableError';
  }
}
