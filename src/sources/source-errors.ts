/** Access was refused or challenged (HTTP 403/429, CAPTCHA, bot protection). Never retry or bypass. */
export class SourceBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceBlockedError';
  }
}

/** The source answered, but not with something usable (bad status, wrong content, changed markup). */
export class SourceResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceResponseError';
  }
}
