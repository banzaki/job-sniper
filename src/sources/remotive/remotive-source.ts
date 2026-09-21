import type { Opportunity, OpportunitySummary } from '../../domain/opportunity.js';
import type { SourceCache } from '../../storage/source-cache-store.js';
import type { ListingPage, OpportunitySource } from '../opportunity-source.js';
import { SourceBlockedError, SourceNotFoundError, SourceResponseError } from '../source-errors.js';
import { jobExternalId, parseFeed, SOURCE_ID, toOpportunity, toSummary, type RemotiveJob } from './remotive-parser.js';

export { SOURCE_ID } from './remotive-parser.js';

/** The documented endpoint (https://github.com/remotive-com/remote-jobs-api), restricted to programming jobs. */
export const REMOTIVE_URL = 'https://remotive.com/api/remote-jobs?category=software-dev';

/** The documentation advises at most 4 queries a day; 6 hours keeps every day at or below that. */
export const MIN_INTERVAL_HOURS = 6;
const HOUR_MS = 3_600_000;
const MAX_RETRY_AFTER_SECONDS = 7 * 24 * 3600;
const USER_AGENT = 'JobSniper/0.1 (personal opportunity monitor)';

export interface RemotiveOptions {
  cache: SourceCache;
  fetchFn?: typeof fetch;
  now?: () => Date;
  /** Hours between two queries, at least MIN_INTERVAL_HOURS. Failed attempts count too. */
  minIntervalHours?: number;
  timeoutMs?: number;
  url?: string;
}

/** How the last listing was obtained; the terminal report and the tests read it. */
export interface RemotiveLoad {
  mode: 'network' | 'cache' | 'stale' | 'none';
  /** When the data in use was downloaded. */
  fetchedAt: string | null;
  /** Why the network was not (successfully) used, when that is the case. */
  note: string | null;
  nextAttemptAt: string | null;
}

/**
 * Remotive as an OpportunitySource. The API returns every current job, with its description, in ONE response, so:
 *  - the listing is that response (single page), kept in a persistent cache together with the time of the last
 *    attempt; a new request is made only when the minimum interval has passed, whatever the outcome of the last one;
 *  - the "detail" of a job is read from that same cached response (no request per job), so it survives restarts;
 *  - a failure with an older response available serves that response instead of failing; HTTP 429 or 403 stops
 *    querying until Retry-After (or the interval, if longer) has passed.
 */
export class RemotiveSource implements OpportunitySource {
  readonly id = SOURCE_ID;

  /** Requests made to the API by this instance. */
  requestCount = 0;
  lastLoad: RemotiveLoad = { mode: 'none', fetchedAt: null, note: null, nextAttemptAt: null };

  private readonly cache: SourceCache;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly url: string;
  private parsed: { fetchedAt: string; jobs: Map<string, RemotiveJob>; ordered: RemotiveJob[] } | null = null;

  constructor(options: RemotiveOptions) {
    this.cache = options.cache;
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.intervalMs = Math.max(MIN_INTERVAL_HOURS, options.minIntervalHours ?? MIN_INTERVAL_HOURS) * HOUR_MS;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.url = options.url ?? REMOTIVE_URL;
  }

  /** One page only: the whole feed. Any cursor other than the first means "nothing further". */
  async listRecent(cursor: string | null = null): Promise<ListingPage> {
    if (cursor !== null) return { items: [], nextCursor: null };
    const feed = await this.loadFeed();
    const summaries: OpportunitySummary[] = [];
    for (const job of feed.ordered) {
      const summary = toSummary(job, { feedFetchedAt: feed.fetchedAt });
      if (summary) summaries.push(summary);
    }
    if (summaries.length === 0) {
      throw new SourceResponseError('The Remotive response has no usable job (id, title and Remotive URL are required).');
    }
    return { items: summaries, nextCursor: null };
  }

  /** Never makes a request: the job comes from the stored response of the last successful query. */
  async fetchDetail(externalId: string): Promise<Opportunity> {
    const feed = this.readCachedFeed();
    if (!feed) throw new SourceNotFoundError(`No stored Remotive response to read job ${externalId} from.`);
    const job = feed.jobs.get(externalId);
    if (!job) {
      throw new SourceNotFoundError(`Job ${externalId} is not in the latest stored Remotive response (it may have expired).`);
    }
    const opportunity = toOpportunity(job, { feedFetchedAt: feed.fetchedAt });
    if (!opportunity) throw new SourceResponseError(`Job ${externalId} lacks a usable id, title or Remotive URL.`);
    return opportunity;
  }

  private async loadFeed(): Promise<{ fetchedAt: string; ordered: RemotiveJob[] }> {
    const now = this.now();
    const entry = this.cache.get(SOURCE_ID);
    const waitingUntil = entry?.nextAttemptAt ? Date.parse(entry.nextAttemptAt) : 0;

    if (now.getTime() < waitingUntil) {
      const cached = this.readCachedFeed();
      this.lastLoad = {
        mode: cached ? 'cache' : 'none',
        fetchedAt: cached?.fetchedAt ?? null,
        note: `next query allowed at ${entry?.nextAttemptAt}${entry?.lastError ? ` (last attempt failed: ${entry.lastError})` : ''}`,
        nextAttemptAt: entry?.nextAttemptAt ?? null,
      };
      if (!cached) throw new SourceResponseError(`Remotive was not queried: ${this.lastLoad.note}.`);
      return cached;
    }

    const at = now.toISOString();
    const nextAttemptAt = new Date(now.getTime() + this.intervalMs).toISOString();
    // Recorded BEFORE the request: an attempt that dies half way still counts against the interval.
    this.cache.beginAttempt(SOURCE_ID, at, nextAttemptAt);

    try {
      const body = await this.download();
      const jobs = parseFeed(body);
      if (jobs.length === 0) throw new SourceResponseError('The Remotive response lists no jobs.');
      this.cache.recordSuccess(SOURCE_ID, body, at, nextAttemptAt);
      this.parsed = null;
      this.lastLoad = { mode: 'network', fetchedAt: at, note: null, nextAttemptAt };
      return this.readCachedFeed() ?? { fetchedAt: at, ordered: jobs };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryAfter = error instanceof SourceBlockedError ? error.retryAfterSeconds : null;
      const next = new Date(now.getTime() + Math.max(this.intervalMs, (retryAfter ?? 0) * 1000)).toISOString();
      this.cache.recordFailure(SOURCE_ID, at, message, next);

      const stale = this.readCachedFeed();
      if (stale) {
        this.lastLoad = { mode: 'stale', fetchedAt: stale.fetchedAt, note: `query failed, using the stored response: ${message}`, nextAttemptAt: next };
        return stale;
      }
      this.lastLoad = { mode: 'none', fetchedAt: null, note: message, nextAttemptAt: next };
      throw error;
    }
  }

  private readCachedFeed(): { fetchedAt: string; jobs: Map<string, RemotiveJob>; ordered: RemotiveJob[] } | null {
    const entry = this.cache.get(SOURCE_ID);
    if (!entry?.payloadJson || !entry.fetchedAt) return null;
    if (this.parsed?.fetchedAt === entry.fetchedAt) return this.parsed;
    const ordered = parseFeed(entry.payloadJson);
    const jobs = new Map<string, RemotiveJob>();
    for (const job of ordered) {
      const id = jobExternalId(job);
      if (id !== null && !jobs.has(id)) jobs.set(id, job);
    }
    this.parsed = { fetchedAt: entry.fetchedAt, jobs, ordered };
    return this.parsed;
  }

  private async download(): Promise<string> {
    this.requestCount += 1;
    let response: Response;
    try {
      response = await this.fetchFn(this.url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new SourceResponseError(`Request to the Remotive API timed out after ${this.timeoutMs}ms.`);
      }
      throw new SourceResponseError(`Network error requesting the Remotive API: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (response.status === 429 || response.status === 403) {
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'), this.now());
      throw new SourceBlockedError(
        `HTTP ${response.status} from the Remotive API${retryAfter ? ` (Retry-After ${retryAfter}s)` : ''}. Access is being refused; stopping without retry.`,
        retryAfter,
      );
    }
    if (response.headers.get('cf-mitigated')) {
      throw new SourceBlockedError('Bot-protection challenge detected for the Remotive API; stopping.');
    }
    if (!response.ok) throw new SourceResponseError(`Unexpected HTTP ${response.status} from the Remotive API.`);
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('json')) {
      throw new SourceResponseError(`Expected JSON from the Remotive API but received "${contentType}".`);
    }
    return response.text();
  }
}

/** Retry-After is either a number of seconds or an HTTP date. Anything else, or a negative wait, is ignored. */
export function parseRetryAfter(value: string | null, now: Date): number | null {
  if (!value) return null;
  const text = value.trim();
  let seconds: number;
  if (/^\d+$/.test(text)) {
    seconds = Number(text);
  } else {
    const date = Date.parse(text);
    if (Number.isNaN(date)) return null;
    seconds = Math.ceil((date - now.getTime()) / 1000);
  }
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}
