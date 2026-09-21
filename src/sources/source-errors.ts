/** Access was refused or challenged (HTTP 403/429, CAPTCHA, bot protection). Never retry or bypass. */
export class SourceBlockedError extends Error {
  /** Seconds the source asked us to wait (Retry-After), when it said so. */
  readonly retryAfterSeconds: number | null;

  constructor(message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = 'SourceBlockedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The source says the item does not exist or is not accessible (HTTP 404/410 or its "cannot access" page). */
export class SourceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceNotFoundError';
  }
}

/** The source answered, but not with something usable (bad status, wrong content, changed markup). */
export class SourceResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceResponseError';
  }
}
