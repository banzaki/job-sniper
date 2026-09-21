import { SourceAuthError, SourceBlockedError, SourceNotFoundError, SourceResponseError } from '../source-errors.js';

export const BASE_URL = 'https://www.freelancer.com';

const USER_AGENT = 'JobSniper/0.1 (personal opportunity monitor)';
const MAX_RETRY_AFTER_SECONDS = 7 * 24 * 3600;

/** What the source needs from the API: one GET returning the parsed `result`, and a request counter. */
export interface FreelancerApi {
  /** `pathAndQuery` starts with /api/. Returns the "result" member of a successful response. */
  get(pathAndQuery: string): Promise<unknown>;
  readonly requestCount: number;
}

export interface ClientOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  /** Minimum gap between two requests; requests are sequential. */
  minIntervalMs?: number;
}

/**
 * Plain `fetch` client for the official Freelancer.com API. The Personal Access Token travels only in the
 * "Freelancer-OAuth-V1" request header; it is never put in a URL, never logged and scrubbed from every error text.
 */
export class FreelancerClient implements FreelancerApi {
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly minIntervalMs: number;
  private lastRequestAt = 0;
  private requests = 0;

  constructor(token: string, options: ClientOptions = {}) {
    this.token = token;
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.minIntervalMs = options.minIntervalMs ?? 1_000;
  }

  get requestCount(): number {
    return this.requests;
  }

  async get(pathAndQuery: string): Promise<unknown> {
    if (!pathAndQuery.startsWith('/api/')) throw new Error(`Refusing a request outside the Freelancer.com API: ${pathAndQuery}`);
    await this.throttle();
    this.requests += 1;
    const where = pathAndQuery.split('?')[0] ?? pathAndQuery;

    let response: Response;
    try {
      response = await this.fetchFn(`${BASE_URL}${pathAndQuery}`, {
        headers: { 'Freelancer-OAuth-V1': this.token, Accept: 'application/json', 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new SourceResponseError(`Request to Freelancer.com timed out after ${this.timeoutMs}ms: ${where}`);
      }
      throw new SourceResponseError(`Network error requesting Freelancer.com ${where}: ${this.scrub(error instanceof Error ? error.message : String(error))}`);
    }

    if (response.status === 401) {
      throw new SourceAuthError(
        'Freelancer.com refused the credentials (HTTP 401). The Personal Access Token may have expired (it lasts 30 days) or been revoked: ' +
          'create a new one and update FREELANCER_OAUTH_TOKEN in the local .env. Freelancer.com collection is stopped for now.',
      );
    }
    if (response.status === 403 || response.status === 429) {
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      throw new SourceBlockedError(
        `HTTP ${response.status} from Freelancer.com ${where}${retryAfter ? ` (Retry-After ${retryAfter}s)` : ''}. Access is being refused; stopping without retry.`,
        retryAfter,
      );
    }
    if (response.status === 404 || response.status === 410) throw new SourceNotFoundError(`HTTP ${response.status} from Freelancer.com ${where}: not found.`);
    if (!response.ok) throw new SourceResponseError(`Unexpected HTTP ${response.status} from Freelancer.com ${where}.`);
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('json')) {
      throw new SourceResponseError(`Expected JSON from Freelancer.com ${where} but received "${contentType}".`);
    }

    let body: unknown;
    try {
      body = JSON.parse(await response.text());
    } catch {
      throw new SourceResponseError(`Freelancer.com ${where} returned a body that is not valid JSON.`);
    }
    const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    if (record.status !== 'success') {
      const code = typeof record.error_code === 'string' ? record.error_code : '';
      const message = this.scrub(typeof record.message === 'string' ? record.message : 'no message');
      if (/notfound/i.test(code)) throw new SourceNotFoundError(`Freelancer.com ${where}: ${message}`);
      throw new SourceResponseError(`Freelancer.com ${where} answered with an error${code ? ` (${code})` : ''}: ${message}`);
    }
    return record.result;
  }

  private scrub(text: string): string {
    return this.token === '' ? text : text.split(this.token).join('[token]');
  }

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastRequestAt = Date.now();
  }
}

/** Retry-After as seconds or an HTTP date; anything else, or a wait that is not positive, is ignored. */
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const text = value.trim();
  const seconds = /^\d+$/.test(text) ? Number(text) : Math.ceil((Date.parse(text) - Date.now()) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}
