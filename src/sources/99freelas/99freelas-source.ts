import type { Opportunity, OpportunityBudget } from '../../domain/opportunity.js';
import type { ListingPage, OpportunitySource } from '../opportunity-source.js';
import { SourceResponseError } from '../source-errors.js';
import { BASE_URL, Freelas99Client, type HtmlFetcher } from './99freelas-client.js';
import {
  parseDetail,
  parseLastPage,
  parseListing,
  parseProjectHref,
  type ListingItem,
  type ParsedDetail,
} from './99freelas-parser.js';

export const SOURCE_ID = '99freelas';

const LISTING_URL = `${BASE_URL}/projects?order=mais-recentes`;
const SUMMARY_MAX_LENGTH = 280;

/**
 * The site resolves a project by its trailing numeric id and ignores the slug, so this
 * placeholder slug is enough when only the id is known (verified against live pages).
 */
const PLACEHOLDER_SLUG = 'x';

export interface StatusResolution {
  status: Opportunity['status'];
  evidence: string;
}

/**
 * Maps the site's status code to the domain status, only with direct evidence.
 *  - 2: the listing filters on { id: 2, name: "Aguardando propostas" } -> open
 *  - 5: the page shows a "Cancelado" status button with class status-5 -> cancelled
 *  - 15: "Aguardando aprovação e propostas" alone is NOT enough; it is open only when the
 *        page independently offers a real "Enviar proposta" action, otherwise unknown
 * No code has been observed for "closed" yet, so that value is never emitted.
 */
export function resolveStatus(
  detail: Pick<ParsedDetail, 'statusCode' | 'statusLabel' | 'canSubmitProposal'>,
): StatusResolution {
  switch (detail.statusCode) {
    case '2':
      return { status: 'open', evidence: 'code 2 matches the site listing filter "Aguardando propostas"' };
    case '5':
      return {
        status: 'cancelled',
        evidence: `code 5 with status button text "${detail.statusLabel ?? ''}"`,
      };
    case '15':
      return detail.canSubmitProposal
        ? { status: 'open', evidence: 'code 15 plus a real "Enviar proposta" action on the page' }
        : {
            status: 'unknown',
            evidence: 'code 15 without a "Enviar proposta" action: no independent evidence of open applications',
          };
    default:
      return { status: 'unknown', evidence: `status code ${detail.statusCode} has no known mapping` };
  }
}

export class Freelas99Source implements OpportunitySource {
  readonly id = SOURCE_ID;

  private readonly http: HtmlFetcher;
  /** What the last listing said, so the detail step can note divergences. */
  private readonly listed = new Map<string, { item: ListingItem; discoveredAt: string }>();

  constructor(http: HtmlFetcher = new Freelas99Client()) {
    this.http = http;
  }

  /** The cursor is the listing page number ("2", "3", ...); omit it for the newest page. */
  async listRecent(cursor: string | null = null): Promise<ListingPage> {
    const page = pageFromCursor(cursor);
    const url = page === 1 ? LISTING_URL : `${LISTING_URL}&page=${page}`;
    const html = await this.http.fetchHtml(url);
    const items = parseListing(html);

    if (items.length === 0) {
      // Past the last page the site answers HTTP 200 with an empty list: that is the end, not an error.
      if (page > 1) return { items: [], nextCursor: null };
      throw new SourceResponseError(
        `No valid opportunities found in ${url}. The markup may have changed or access may be restricted.`,
      );
    }

    if (page === 1) this.listed.clear();
    const discoveredAt = new Date().toISOString();
    const summaries = items.map((item) => {
      this.listed.set(item.externalId, { item, discoveredAt });
      return {
        sourceId: this.id,
        externalId: item.externalId,
        title: item.title,
        url: item.url,
        summary: item.description ? truncate(item.description, SUMMARY_MAX_LENGTH) : null,
        publishedAt: item.publishedAt,
        discoveredAt,
      };
    });

    const lastPage = parseLastPage(html);
    return {
      items: summaries,
      nextCursor: lastPage !== null && page < lastPage ? String(page + 1) : null,
    };
  }

  async fetchDetail(externalId: string): Promise<Opportunity> {
    if (!/^\d+$/.test(externalId)) {
      throw new Error(`Invalid ${SOURCE_ID} externalId: "${externalId}"`);
    }

    const listed = this.listed.get(externalId);
    const requestUrl =
      listed?.item.url ?? `${BASE_URL}/project/${PLACEHOLDER_SLUG}-${externalId}`;
    const detail = parseDetail(await this.http.fetchHtml(requestUrl));

    const canonical = parseProjectHref(detail.canonicalUrl);
    if (!canonical || canonical.externalId !== externalId) {
      throw new SourceResponseError(
        `Detail page for ${externalId} points to an unexpected canonical URL: ${detail.canonicalUrl}`,
      );
    }

    const fetchedAt = new Date().toISOString();
    return toOpportunity(this.id, externalId, canonical.url, detail, listed ?? null, fetchedAt);
  }
}

export function toOpportunity(
  sourceId: string,
  externalId: string,
  url: string,
  detail: ParsedDetail,
  listed: { item: ListingItem; discoveredAt: string } | null,
  fetchedAt: string,
): Opportunity {
  const resolution = resolveStatus(detail);
  return {
    sourceId,
    externalId,
    title: detail.title,
    url,
    summary: detail.description ? truncate(detail.description, SUMMARY_MAX_LENGTH) : null,
    // Detail wins; the listing epoch is the fallback when the detail date is relative.
    publishedAt: detail.publishedAt ?? listed?.item.publishedAt ?? null,
    discoveredAt: listed?.discoveredAt ?? fetchedAt,
    description: detail.description,
    category: detail.category,
    subcategory: detail.subcategory,
    experienceLevel: detail.experienceLevel,
    skills: detail.skills,
    budget: toBudget(detail.budgetRaw),
    proposalCount: detail.proposalCount,
    interestedCount: detail.interestedCount,
    status: resolution.status,
    fetchedAt,
    sourceMetadata: {
      statusCode: detail.statusCode,
      statusLabel: detail.statusLabel,
      statusEvidence: resolution.evidence,
      statusNormalized: resolution.status,
      canSubmitProposal: detail.canSubmitProposal,
      visibility: detail.visibility,
      exclusive: detail.exclusive,
      budgetRaw: detail.budgetRaw,
      minimumValueRaw: detail.minimumValueRaw,
      deadlineAt: detail.deadlineAt,
      publishedRaw: detail.publishedRaw,
      listingDivergence: describeDivergence(detail, listed?.item ?? null),
    },
  };
}

/**
 * Only "Aberto" (open budget) has been observed. Any other text is kept raw in
 * sourceMetadata and reported as kind "unknown" rather than parsed by guesswork.
 */
function toBudget(raw: string | null): OpportunityBudget | null {
  if (raw === null) return null;
  const kind = raw.toLowerCase() === 'aberto' ? 'open' : 'unknown';
  return { currency: 'BRL', kind, min: null, max: null };
}

function describeDivergence(detail: ParsedDetail, item: ListingItem | null): string | null {
  if (!item) return null;
  const differences: string[] = [];
  if (item.title !== detail.title) {
    differences.push(`title: listing="${item.title}" detail="${detail.title}"`);
  }
  if (item.proposalCount !== null && item.proposalCount !== detail.proposalCount) {
    differences.push(`proposals: listing=${item.proposalCount} detail=${detail.proposalCount}`);
  }
  if (item.interestedCount !== null && item.interestedCount !== detail.interestedCount) {
    differences.push(`interested: listing=${item.interestedCount} detail=${detail.interestedCount}`);
  }
  return differences.length > 0 ? differences.join('; ') : null;
}

function pageFromCursor(cursor: string | null): number {
  if (cursor === null) return 1;
  if (!/^[1-9]\d{0,5}$/.test(cursor)) {
    throw new Error(`Invalid ${SOURCE_ID} cursor: "${cursor}"`);
  }
  return Number(cursor);
}

function truncate(text: string, maxLength: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxLength) return flat;
  const cut = flat.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
