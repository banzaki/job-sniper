import type { EmploymentType, Opportunity, OpportunitySummary } from '../../domain/opportunity.js';
import { UNKNOWN_ACCESS } from '../../domain/opportunity.js';
import { SourceResponseError } from '../source-errors.js';
import { htmlToText } from './html-to-text.js';

export const SOURCE_ID = 'remotive';

const SUMMARY_MAX_LENGTH = 280;
const TITLE_MAX_LENGTH = 300;
const FEED_DELAY_HOURS = 24;

/** One job as the API documents it. Everything is optional here: the parser decides what is usable. */
export interface RemotiveJob {
  id?: unknown;
  url?: unknown;
  title?: unknown;
  company_name?: unknown;
  category?: unknown;
  tags?: unknown;
  job_type?: unknown;
  publication_date?: unknown;
  candidate_required_location?: unknown;
  salary?: unknown;
  description?: unknown;
}

/** The API's own text is kept for the record ("0-legal-notice"), but only "jobs" is read. */
export function parseFeed(payloadJson: string): RemotiveJob[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch (error) {
    throw new SourceResponseError(`The Remotive response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const jobs = typeof parsed === 'object' && parsed !== null ? (parsed as { jobs?: unknown }).jobs : undefined;
  if (!Array.isArray(jobs)) {
    throw new SourceResponseError('The Remotive response has no "jobs" list; the API format may have changed.');
  }
  return jobs.filter((job): job is RemotiveJob => typeof job === 'object' && job !== null);
}

const clean = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat === '' ? null : flat;
};

/** The API id as our external id: the id it provides, as text. Numbers and non-empty strings of digits are accepted. */
export function jobExternalId(job: RemotiveJob): string | null {
  const { id } = job;
  if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) return String(id);
  if (typeof id === 'string' && /^[1-9]\d{0,17}$/.test(id.trim())) return id.trim();
  return null;
}

/** Only https pages on remotive.com are the "original Remotive URL"; anything else is not trusted as a link. */
export function remotiveUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || (host !== 'remotive.com' && !host.endsWith('.remotive.com'))) return null;
    return url.href;
  } catch {
    return null;
  }
}

const EMPLOYMENT_TYPES: Record<string, EmploymentType> = {
  freelance: 'freelance',
  contract: 'contract',
  full_time: 'full_time',
  part_time: 'part_time',
  internship: 'internship',
};

/** "contract" stays a contract (never assumed to be a short project); a missing value stays unknown. */
export function normalizeEmploymentType(raw: unknown): EmploymentType {
  const label = clean(raw);
  if (label === null) return 'unknown';
  return EMPLOYMENT_TYPES[label.toLowerCase().replace(/[\s-]+/g, '_')] ?? 'other';
}

interface PublishedDate {
  /** A real instant, only when the source stated the time zone. */
  iso: string | null;
  raw: string | null;
  timezone: 'stated' | 'not stated' | 'unusable';
  /** The calendar day (YYYY-MM-DD) the source published without a time zone; the only precision it gives. */
  day: string | null;
}

/**
 * The API date can come without a time zone ("2026-09-20T13:15:01"). A time without a zone is not an instant, so
 * no zone is invented: publishedAt stays null and the raw text is kept. Only a value with an explicit zone
 * (Z or +hh:mm) becomes an ISO instant.
 */
export function parsePublished(value: unknown): PublishedDate {
  const raw = clean(value);
  if (raw === null) return { iso: null, raw: null, timezone: 'unusable', day: null };
  const stated = /(?:z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const time = Date.parse(raw);
  if (Number.isNaN(time)) return { iso: null, raw, timezone: 'unusable', day: null };
  if (stated) return { iso: new Date(time).toISOString(), raw, timezone: 'stated', day: null };
  const day = /^\d{4}-\d{2}-\d{2}/.exec(raw)?.[0] ?? null;
  return { iso: null, raw, timezone: 'not stated', day };
}

function truncate(text: string, maxLength: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxLength) return flat;
  const cut = flat.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export interface NormalizeContext {
  /** When the feed was actually downloaded (not when it was read back from the cache). */
  feedFetchedAt: string;
}

/** null when the job lacks what identifies it (id, title or a Remotive URL): such an entry is never invented. */
export function toSummary(job: RemotiveJob, context: NormalizeContext): OpportunitySummary | null {
  const externalId = jobExternalId(job);
  const title = clean(job.title);
  const url = remotiveUrl(job.url);
  if (externalId === null || title === null || url === null) return null;
  const description = typeof job.description === 'string' ? htmlToText(job.description) : '';
  return {
    sourceId: SOURCE_ID,
    externalId,
    title: truncate(title, TITLE_MAX_LENGTH),
    url,
    summary: description === '' ? null : truncate(description, SUMMARY_MAX_LENGTH),
    publishedAt: parsePublished(job.publication_date).iso,
    discoveredAt: context.feedFetchedAt,
  };
}

/**
 * Full normalization. Absent fields stay unknown (null, an empty list or "unknown"); the salary text is kept as
 * published, with no currency, period or conversion inferred; it is never a project budget. The job is
 * "open" only in the sense of evidence we have: the API lists it as a live job; the feed is delayed by 24 hours.
 */
export function toOpportunity(job: RemotiveJob, context: NormalizeContext): Opportunity | null {
  const summary = toSummary(job, context);
  if (!summary) return null;
  const description = typeof job.description === 'string' ? htmlToText(job.description) : '';
  const published = parsePublished(job.publication_date);
  const tags = Array.isArray(job.tags) ? job.tags.map(clean).filter((tag): tag is string => tag !== null) : [];

  return {
    ...summary,
    description,
    access: { ...UNKNOWN_ACCESS },
    category: clean(job.category),
    subcategory: null,
    experienceLevel: null,
    skills: [...new Set(tags)],
    budget: null,
    proposalCount: null,
    interestedCount: null,
    status: 'open',
    fetchedAt: context.feedFetchedAt,
    employmentType: normalizeEmploymentType(job.job_type),
    locationRequirement: clean(job.candidate_required_location),
    compensation: clean(job.salary),
    sourceMetadata: {
      company: clean(job.company_name),
      jobTypeRaw: clean(job.job_type),
      publishedRaw: published.raw,
      publishedTimezone: published.timezone,
      publishedDay: published.day,
      statusEvidence: `listed by the Remotive API at ${context.feedFetchedAt}; the feed is delayed ${FEED_DELAY_HOURS} h and applications were not verified`,
      feedFetchedAt: context.feedFetchedAt,
      feedDelayHours: FEED_DELAY_HOURS,
    },
  };
}
