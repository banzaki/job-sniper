import type { Opportunity, OpportunitySummary } from '../../domain/opportunity.js';
import type { SourceCache } from '../../storage/source-cache-store.js';
import type { ListingPage, OpportunitySource } from '../opportunity-source.js';
import { SourceAuthError, SourceBlockedError, SourceNotFoundError, SourceResponseError } from '../source-errors.js';
import type { FreelancerApi } from './freelancer-client.js';
import {
  parseDetailResult,
  parseSearchResult,
  projectExternalId,
  SOURCE_ID,
  toOpportunity,
  toSummary,
  type FreelancerProject,
} from './freelancer-parser.js';

export { SOURCE_ID } from './freelancer-parser.js';

const SEARCH_PATH = '/api/projects/0.1/projects/active/';
const PROJECT_PATH = '/api/projects/0.1/projects';
const JOBS_PATH = '/api/projects/0.1/jobs/';

const PAGE_SIZE = 20;
const LOOKBACK_DAYS = 7;
const HOUR_MS = 3_600_000;
/** The API terms ask for cached data to be refreshed at least every 24 hours (the skill-id list is cached that long). */
const JOB_IDS_MAX_AGE_HOURS = 24;
/** After a refusal (401, 403, 429) the source is left alone for at least this long, or for Retry-After if longer. */
const COOLDOWN_HOURS = 6;
const JOB_IDS_KEY = `${SOURCE_ID}-jobs`;

/** Names the profile uses that the API spells differently. Only used to look skills up; unknown names are ignored. */
const SKILL_NAME_ALIASES: Readonly<Record<string, string>> = { react: 'React.js', 'node.js': 'Node.js', typescript: 'TypeScript' };

export interface FreelancerOptions {
  api: FreelancerApi;
  /** Stores the resolved skill ids and the cooldown after a refusal. */
  cache: SourceCache;
  /** Skill names from the active profile, for example its strong signals. The API decides which of them exist. */
  skillNames: readonly string[];
  now?: () => Date;
  pageSize?: number;
  lookbackDays?: number;
}

/**
 * The Freelancer.com official API as an OpportunitySource, for freelance projects that are active and recent.
 *  - Listing: GET /api/projects/0.1/projects/active/ filtered by skill ids, newest first, limited to the last days,
 *    with full descriptions, so the listing already carries everything the detail step needs.
 *  - Detail: a project listed in this same run is used as it is (seconds old); one from an earlier run is fetched
 *    again from the API, so alerts never rest on a payload older than the 24 hours the terms allow.
 *  - A 401, 403 or 429 starts a stored cooldown: later runs do not even try until it ends.
 */
export class FreelancerSource implements OpportunitySource {
  readonly id = SOURCE_ID;

  private readonly api: FreelancerApi;
  private readonly cache: SourceCache;
  private readonly skillNames: string[];
  private readonly now: () => Date;
  private readonly pageSize: number;
  private readonly lookbackDays: number;
  private jobIds: number[] | null = null;
  /** What this run's listing returned, keyed by id, with the moment it was downloaded. */
  private readonly listed = new Map<string, { project: FreelancerProject; fetchedAt: string }>();

  constructor(options: FreelancerOptions) {
    this.api = options.api;
    this.cache = options.cache;
    this.skillNames = [...new Set(options.skillNames.map((name) => name.trim()).filter((name) => name !== ''))];
    this.now = options.now ?? (() => new Date());
    this.pageSize = options.pageSize ?? PAGE_SIZE;
    this.lookbackDays = options.lookbackDays ?? LOOKBACK_DAYS;
  }

  /** The cursor is the result offset ("20", "40", ...); omit it for the newest projects. */
  async listRecent(cursor: string | null = null): Promise<ListingPage> {
    const offset = cursor === null ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0 || (cursor !== null && !/^\d+$/.test(cursor))) throw new Error(`Invalid ${SOURCE_ID} cursor: "${cursor}"`);
    this.assertNotCoolingDown();

    const fetchedAt = this.now().toISOString();
    const ids = await this.resolveJobIds();
    const from = Math.floor(this.now().getTime() / 1000) - this.lookbackDays * 86_400;
    const query = [
      `limit=${this.pageSize}`,
      `offset=${offset}`,
      'sort_field=submitdate',
      `from_time=${from}`,
      ...ids.map((id) => `jobs%5B%5D=${id}`),
      'full_description=true',
      'job_details=true',
    ].join('&');

    const { projects, total } = parseSearchResult(await this.guarded(() => this.api.get(`${SEARCH_PATH}?${query}`)));
    if (offset === 0) this.listed.clear();
    const summaries: { summary: OpportunitySummary; time: number }[] = [];
    for (const project of projects) {
      const summary = toSummary(project, fetchedAt);
      if (!summary) continue;
      this.listed.set(summary.externalId, { project, fetchedAt });
      summaries.push({ summary, time: summary.publishedAt ? Date.parse(summary.publishedAt) : 0 });
    }
    // Newest first, whatever order the API used inside the page.
    summaries.sort((a, b) => b.time - a.time);

    const next = offset + this.pageSize;
    const more = projects.length >= this.pageSize && (total === null || next < total);
    return { items: summaries.map((entry) => entry.summary), nextCursor: more ? String(next) : null };
  }

  async fetchDetail(externalId: string): Promise<Opportunity> {
    if (!/^[1-9]\d{0,17}$/.test(externalId)) throw new Error(`Invalid ${SOURCE_ID} externalId: "${externalId}"`);

    const known = this.listed.get(externalId);
    let project = known?.project ?? null;
    let fetchedAt = known?.fetchedAt ?? this.now().toISOString();
    if (!project) {
      this.assertNotCoolingDown();
      fetchedAt = this.now().toISOString();
      const result = await this.guarded(() => this.api.get(`${PROJECT_PATH}/${externalId}/?full_description=true&job_details=true`));
      project = parseDetailResult(result);
      if (!project) throw new SourceNotFoundError(`Freelancer.com returned no project for ${externalId}.`);
      if (projectExternalId(project) !== externalId) {
        throw new SourceResponseError(`Freelancer.com answered for a different project than ${externalId}.`);
      }
    }
    const opportunity = toOpportunity(project, fetchedAt);
    if (!opportunity) throw new SourceResponseError(`Project ${externalId} lacks a usable id, title or page URL.`);
    return opportunity;
  }

  /** Skill names -> ids, from the API, kept for 24 hours. Without a single id the filter would match everything: an error. */
  private async resolveJobIds(): Promise<number[]> {
    if (this.jobIds) return this.jobIds;
    const entry = this.cache.get(JOB_IDS_KEY);
    const fresh = entry?.payloadJson && entry.fetchedAt && this.now().getTime() - Date.parse(entry.fetchedAt) < JOB_IDS_MAX_AGE_HOURS * HOUR_MS;
    if (entry?.payloadJson && fresh) {
      this.jobIds = parseIds(entry.payloadJson);
      if (this.jobIds.length > 0) return this.jobIds;
    }

    const names = [...new Set(this.skillNames.map((name) => SKILL_NAME_ALIASES[name.toLowerCase()] ?? name))];
    if (names.length === 0) throw new SourceResponseError('No skill names to search Freelancer.com with.');
    const query = names.map((name) => `job_names%5B%5D=${encodeURIComponent(name)}`).join('&');
    const at = this.now().toISOString();
    try {
      const result = await this.guarded(() => this.api.get(`${JOBS_PATH}?${query}`));
      const wanted = new Set(names.map((name) => name.toLowerCase()));
      const found = (Array.isArray(result) ? result : typeof result === 'object' && result !== null ? Object.values(result) : [])
        .map((job) => (typeof job === 'object' && job !== null ? (job as { id?: unknown; name?: unknown }) : {}))
        .filter((job): job is { id: number; name: string } => typeof job.id === 'number' && typeof job.name === 'string' && wanted.has(job.name.toLowerCase()));
      const ids = [...new Set(found.map((job) => job.id))];
      if (ids.length === 0) throw new SourceResponseError('None of the profile skills exists on Freelancer.com; refusing to search without a skill filter.');
      this.cache.recordSuccess(JOB_IDS_KEY, JSON.stringify({ ids, names: found.map((job) => job.name) }), at, at);
      this.jobIds = ids;
      return ids;
    } catch (error) {
      // An older list of ids is still a valid filter; only project data has the 24-hour rule.
      const older = entry?.payloadJson ? parseIds(entry.payloadJson) : [];
      if (older.length > 0 && !(error instanceof SourceAuthError) && !(error instanceof SourceBlockedError)) {
        this.jobIds = older;
        return older;
      }
      throw error;
    }
  }

  private assertNotCoolingDown(): void {
    const entry = this.cache.get(SOURCE_ID);
    if (entry?.nextAttemptAt && Date.parse(entry.nextAttemptAt) > this.now().getTime()) {
      throw new SourceResponseError(
        `Freelancer.com was not queried: waiting until ${entry.nextAttemptAt} after a refusal (${entry.lastError ?? 'no detail'}).`,
      );
    }
  }

  /** Runs one request; a refusal (401, 403, 429) is remembered so the next runs do not insist. */
  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      const result = await work();
      const entry = this.cache.get(SOURCE_ID);
      if (entry?.nextAttemptAt || entry?.lastError) {
        const at = this.now().toISOString();
        this.cache.recordSuccess(SOURCE_ID, '{}', at, at);
      }
      return result;
    } catch (error) {
      if (error instanceof SourceAuthError || error instanceof SourceBlockedError) {
        const at = this.now();
        const retryAfter = error instanceof SourceBlockedError ? error.retryAfterSeconds : null;
        const wait = Math.max(COOLDOWN_HOURS * HOUR_MS, (retryAfter ?? 0) * 1000);
        this.cache.recordFailure(SOURCE_ID, at.toISOString(), error.message, new Date(at.getTime() + wait).toISOString());
      }
      throw error;
    }
  }
}

function parseIds(payloadJson: string): number[] {
  try {
    const parsed = JSON.parse(payloadJson) as { ids?: unknown };
    return Array.isArray(parsed.ids) ? parsed.ids.filter((id): id is number => typeof id === 'number') : [];
  } catch {
    return [];
  }
}
