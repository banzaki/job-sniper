import type {
  Opportunity,
  OpportunityBudget,
  OpportunitySummary,
} from '../../domain/opportunity.js';
import type { OpportunitySource } from '../opportunity-source.js';
import { SourceResponseError } from '../source-errors.js';
import { BASE_URL, Freelas99Client, type HtmlFetcher } from './99freelas-client.js';
import {
  parseDetail,
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

/**
 * Site status codes with direct evidence. Anything else stays "unknown" instead of guessed.
 *  - 2: the listing filters on { id: 2, name: "Aguardando propostas" }
 *  - 15: the same listing filter has { id: 15, name: "Aguardando aprovação e propostas" };
 *        a live page with this code showed "Enviar proposta" and already had proposals
 *  - 5: the page shows a "Cancelado" status button with class status-5
 * No code has been observed for "closed" yet, so that value is never emitted.
 */
const STATUS_BY_CODE: Record<string, Opportunity['status']> = {
  '2': 'open',
  '15': 'open',
  '5': 'cancelled',
};

export class Freelas99Source implements OpportunitySource {
  readonly id = SOURCE_ID;

  private readonly http: HtmlFetcher;
  /** What the last listing said, so the detail step can note divergences. */
  private readonly listed = new Map<string, { item: ListingItem; discoveredAt: string }>();

  constructor(http: HtmlFetcher = new Freelas99Client()) {
    this.http = http;
  }

  async listRecent(): Promise<OpportunitySummary[]> {
    const html = await this.http.fetchHtml(LISTING_URL);
    const items = parseListing(html);
    if (items.length === 0) {
      throw new SourceResponseError(
        `No valid opportunities found in ${LISTING_URL}. The markup may have changed or access may be restricted.`,
      );
    }

    const discoveredAt = new Date().toISOString();
    this.listed.clear();
    return items.map((item) => {
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
    status: STATUS_BY_CODE[detail.statusCode] ?? 'unknown',
    fetchedAt,
    sourceMetadata: {
      statusCode: detail.statusCode,
      statusLabel: detail.statusLabel,
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

function truncate(text: string, maxLength: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxLength) return flat;
  const cut = flat.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
