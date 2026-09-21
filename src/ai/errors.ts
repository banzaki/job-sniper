/** The model answered, but not with usable, valid, truthful output. Counted against that opportunity only. */
export class AnalysisInvalidOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisInvalidOutputError';
  }
}

/** Quota or rate limit reached (HTTP 429). The remaining work stays pending; nothing is retried. */
export class AnalysisQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisQuotaError';
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
