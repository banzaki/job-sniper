import type { Opportunity, OpportunityBudget, OpportunitySummary } from '../../domain/opportunity.js';
import { UNKNOWN_ACCESS } from '../../domain/opportunity.js';
import { SourceResponseError } from '../source-errors.js';
import { BASE_URL } from './freelancer-client.js';

export const SOURCE_ID = 'freelancer';

const SUMMARY_MAX_LENGTH = 280;
const TITLE_MAX_LENGTH = 300;
const DESCRIPTION_MAX_LENGTH = 20_000;
/** Categories of skills that mean "technology" in the API's own taxonomy. */
const TECH_CATEGORIES = new Set(['websites, it & software', 'mobile phones & computing']);

/** One project as the official API returns it. Everything is optional: the parser decides what is usable. */
export interface FreelancerProject {
  id?: unknown;
  title?: unknown;
  status?: unknown;
  sub_status?: unknown;
  seo_url?: unknown;
  description?: unknown;
  type?: unknown;
  jobs?: unknown;
  budget?: unknown;
  currency?: unknown;
  bid_stats?: unknown;
  time_submitted?: unknown;
  time_updated?: unknown;
  language?: unknown;
  featured?: unknown;
  urgent?: unknown;
  nonpublic?: unknown;
  hourly_project_info?: unknown;
  upgrades?: unknown;
}

const record = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const text = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat === '' ? null : flat;
};
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** The list of a search response (`result`), with the total the API reports. */
export function parseSearchResult(result: unknown): { projects: FreelancerProject[]; total: number | null } {
  const body = record(result);
  const projects = body?.projects;
  if (!Array.isArray(projects)) throw new SourceResponseError('The Freelancer.com response has no "projects" list; the API format may have changed.');
  return { projects: projects.filter((entry): entry is FreelancerProject => record(entry) !== null), total: num(body?.total_count) };
}

/** A single-project response: the project itself, or a list holding it. */
export function parseDetailResult(result: unknown): FreelancerProject | null {
  const body = record(result);
  if (!body) return null;
  if (Array.isArray(body.projects)) return (body.projects.find((entry) => record(entry) !== null) as FreelancerProject | undefined) ?? null;
  return body.id !== undefined ? (body as FreelancerProject) : null;
}

export function projectExternalId(project: FreelancerProject): string | null {
  const { id } = project;
  if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) return String(id);
  if (typeof id === 'string' && /^[1-9]\d{0,17}$/.test(id.trim())) return id.trim();
  return null;
}

/** The public page of the project, built from the API's own seo_url; null when it is missing or not a plain path. */
export function projectUrl(seoUrl: unknown): string | null {
  if (typeof seoUrl !== 'string' || !/^[A-Za-z0-9_\-./%]+$/.test(seoUrl) || seoUrl.includes('..')) return null;
  return `${BASE_URL}/projects/${seoUrl.replace(/^\/+/, '')}`;
}

/** Plain text kept with its line breaks; control characters removed and the size bounded. */
export function plainText(value: unknown, maxLength = DESCRIPTION_MAX_LENGTH): string {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‍﻿]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (cleaned.length <= maxLength) return cleaned;
  const cut = cleaned.slice(0, maxLength);
  const lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  return `${(lastBreak > maxLength * 0.8 ? cut.slice(0, lastBreak) : cut).trimEnd()}…`;
}

/** open = "active"; a closed, cancelled or finished project is closed; anything else is not confirmed. */
export function normalizeStatus(status: unknown): { status: Opportunity['status']; evidence: string } {
  const label = text(status)?.toLowerCase() ?? null;
  if (label === 'active') return { status: 'open', evidence: 'the API lists the project as "active"' };
  if (label === 'closed' || label === 'finished' || label === 'complete' || label === 'cancelled') {
    return { status: 'closed', evidence: `the API lists the project as "${label}"` };
  }
  return { status: 'unknown', evidence: label === null ? 'the API gave no status' : `the API status "${label}" has no known mapping` };
}

/**
 * Fixed or hourly, in the ORIGINAL currency, exactly as the API states it. Never converted. The rate to USD the API
 * publishes for that currency (`currency.exchange_rate`) is returned beside it, only for the filter's internal use.
 */
export function normalizeBudget(project: FreelancerProject): { budget: OpportunityBudget | null; type: string | null; code: string | null; exchangeRateToUsd: number | null } {
  const type = text(project.type)?.toLowerCase() ?? null;
  const budget = record(project.budget);
  const currency = record(project.currency);
  const code = text(currency?.code)?.toUpperCase() ?? null;
  const rate = num(currency?.exchange_rate);
  const exchangeRateToUsd = rate !== null && rate > 0 ? rate : null;
  if (!budget) return { budget: null, type, code, exchangeRateToUsd };
  const min = num(budget.minimum);
  const max = num(budget.maximum);
  const kind: OpportunityBudget['kind'] = min === null && max === null ? 'unknown' : type === 'hourly' ? 'hourly' : type === 'fixed' ? 'fixed' : 'unknown';
  // Without a currency code nothing is assumed: the amounts are kept, the currency is left empty.
  return { budget: { currency: code ?? '', kind, min, max }, type, code, exchangeRateToUsd };
}

function skillNames(project: FreelancerProject): { names: string[]; category: string | null } {
  const jobs = Array.isArray(project.jobs) ? project.jobs : [];
  const names: string[] = [];
  const categories: string[] = [];
  for (const job of jobs) {
    const entry = record(job);
    const name = text(entry ? entry.name : job);
    if (name) names.push(name);
    const category = text(record(entry?.category)?.name);
    if (category) categories.push(category);
  }
  // A project is "technology" when any of its skills is; otherwise its first skill's category describes it.
  const category = categories.find((label) => TECH_CATEGORIES.has(label.toLowerCase())) ?? categories[0] ?? null;
  return { names: [...new Set(names)], category };
}

function truncate(value: string, maxLength: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxLength) return flat;
  const cut = flat.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

const epochToIso = (value: unknown): string | null => {
  const seconds = num(value);
  return seconds !== null && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
};

/** null when the project lacks its id, its title or a usable page URL: such an entry is never invented. */
export function toSummary(project: FreelancerProject, fetchedAt: string): OpportunitySummary | null {
  const externalId = projectExternalId(project);
  const title = text(project.title);
  const url = projectUrl(project.seo_url);
  if (externalId === null || title === null || url === null) return null;
  const description = plainText(project.description);
  return {
    sourceId: SOURCE_ID,
    externalId,
    title: truncate(title, TITLE_MAX_LENGTH),
    url,
    summary: description === '' ? null : truncate(description, SUMMARY_MAX_LENGTH),
    publishedAt: epochToIso(project.time_submitted),
    discoveredAt: fetchedAt,
  };
}

/**
 * Full normalization. The project type is "freelance" by nature of the platform; the budget keeps its original
 * currency code and its fixed/hourly kind; the date is the API's Unix time (a real instant). Absent fields stay
 * unknown. Freelancer.com data is only as current as `fetchedAt`: the terms ask for a refresh at least every 24 hours.
 */
export function toOpportunity(project: FreelancerProject, fetchedAt: string): Opportunity | null {
  const summary = toSummary(project, fetchedAt);
  if (!summary) return null;
  const { names, category } = skillNames(project);
  const { budget, type, code, exchangeRateToUsd } = normalizeBudget(project);
  const status = normalizeStatus(project.status);
  const bids = record(project.bid_stats);
  const upgrades = record(project.upgrades);

  return {
    ...summary,
    description: plainText(project.description),
    access: { ...UNKNOWN_ACCESS },
    category,
    subcategory: null,
    experienceLevel: null,
    skills: names,
    budget,
    proposalCount: num(bids?.bid_count),
    interestedCount: null,
    status: status.status,
    fetchedAt,
    employmentType: 'freelance',
    sourceMetadata: {
      projectType: type,
      currencyCode: code,
      exchangeRateToUsd,
      budgetMin: budget?.min ?? null,
      budgetMax: budget?.max ?? null,
      bidAverage: num(bids?.bid_avg),
      apiStatus: text(project.status),
      apiSubStatus: text(project.sub_status),
      statusEvidence: status.evidence,
      language: text(project.language),
      timeUpdated: epochToIso(project.time_updated),
      featured: project.featured === true,
      urgent: project.urgent === true,
      nonpublic: project.nonpublic === true,
      upgrades: upgrades ? Object.keys(upgrades).filter((key) => upgrades[key] === true).join(',') || null : null,
      fetchedAt,
      dataMaxAgeHours: 24,
    },
  };
}
