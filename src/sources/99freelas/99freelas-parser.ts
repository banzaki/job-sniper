import { load } from 'cheerio';
import { SourceNotFoundError, SourceResponseError } from '../source-errors.js';
import { BASE_URL } from './99freelas-client.js';

export interface ListingItem {
  externalId: string;
  title: string;
  url: string;
  description: string | null;
  publishedAt: string | null;
  proposalCount: number | null;
  interestedCount: number | null;
}

export interface ParsedDetail {
  title: string;
  canonicalUrl: string;
  description: string;
  /** ISO string, only when the page shows an absolute date; relative dates ("hoje às …") give null. */
  publishedAt: string | null;
  publishedRaw: string | null;
  category: string | null;
  subcategory: string | null;
  experienceLevel: string | null;
  budgetRaw: string | null;
  visibility: string | null;
  minimumValueRaw: string | null;
  proposalCount: number | null;
  interestedCount: number | null;
  deadlineAt: string | null;
  skills: string[];
  statusCode: string;
  statusLabel: string | null;
  /** True when the page offers a real "send proposal" action, independent of the status code. */
  canSubmitProposal: boolean;
  exclusive: boolean;
  /** The "Projeto Exclusivo" flag's own text (with its countdown), unchanged. */
  exclusiveLabel: string | null;
  /** Seconds until the project opens to everyone, only when the text states it unambiguously. */
  exclusiveCountdownSeconds: number | null;
}

const MAX_EXCLUSIVE_COUNTDOWN_SECONDS = 7 * 24 * 3600;

/**
 * Reads "… disponível para todos os profissionais em 23h52m30s." into seconds.
 * Anything not matching that shape exactly (missing phrase, unknown units, zero, absurdly
 * long) returns null: an uncertain countdown must never become a timestamp.
 */
export function parseExclusiveCountdownSeconds(label: string | null): number | null {
  if (!label) return null;
  const match = /dispon[ií]vel para todos os profissionais em\s+((?:\d+\s*[dhms]\s*)+)\.?\s*$/i.exec(label);
  const parts = match?.[1];
  if (!parts) return null;

  const unitSeconds: Record<string, number> = { d: 86_400, h: 3_600, m: 60, s: 1 };
  const seen = new Set<string>();
  let total = 0;
  for (const token of parts.matchAll(/(\d+)\s*([dhms])/gi)) {
    const unit = (token[2] ?? '').toLowerCase();
    if (seen.has(unit)) return null;
    seen.add(unit);
    total += Number(token[1]) * (unitSeconds[unit] ?? 0);
  }
  return total > 0 && total <= MAX_EXCLUSIVE_COUNTDOWN_SECONDS ? total : null;
}

/**
 * Returns the stable project reference for a project link, or null for anything else
 * (project creation, messages, external hosts, links without a numeric id).
 * The canonical URL drops the query string and fragment.
 */
export function parseProjectHref(href: string): { externalId: string; url: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(href, BASE_URL);
  } catch {
    return null;
  }
  if (parsed.origin !== BASE_URL) return null;
  const match = /^\/project\/[^/]+-(\d+)\/?$/.exec(parsed.pathname);
  const externalId = match?.[1];
  if (!externalId) return null;
  return { externalId, url: `${parsed.origin}${parsed.pathname}` };
}

export function parseListing(html: string): ListingItem[] {
  const $ = load(html);
  const items = new Map<string, ListingItem>();

  for (const element of $('li.result-item').toArray()) {
    const card = $(element);
    const anchor = card.find('h1.title a').first();
    const href = anchor.attr('href');
    const title = collapse(anchor.text());
    if (!href || !title) continue;

    const ref = parseProjectHref(href);
    if (!ref) continue;
    const dataId = card.attr('data-id');
    if (dataId && dataId !== ref.externalId) continue;
    if (items.has(ref.externalId)) continue;

    const information = collapse(card.find('p.information').text());
    items.set(ref.externalId, {
      externalId: ref.externalId,
      title,
      url: ref.url,
      description: blockText(card.find('div.description').first().html()) || null,
      publishedAt: epochMsToIso(card.find('p.information b.datetime').first().attr('cp-datetime')),
      proposalCount: matchCount(information, /Propostas:\s*(\d+)/),
      interestedCount: matchCount(information, /Interessados:\s*(\d+)/),
    });
  }

  return [...items.values()];
}

/**
 * Highest page number offered by the listing's pagination control (the "last page" item),
 * or null when the page has no pagination. The control is rendered twice (top and bottom).
 */
export function parseLastPage(html: string): number | null {
  const $ = load(html);
  const pages = $('.pagination-component .page-item')
    .toArray()
    .map((element) => Number($(element).attr('data-page')))
    .filter((page) => Number.isInteger(page) && page >= 1);
  return pages.length > 0 ? Math.max(...pages) : null;
}

export function parseDetail(html: string): ParsedDetail {
  const $ = load(html);

  const title = collapse($('span.nomeProjeto').first().text());
  const statusCode = /idStatusProjeto\s*=\s*'(\d+)'/.exec(html)?.[1];
  if (!title || !statusCode) {
    const pageTitle = collapse($('title').first().text());
    // The site answers HTTP 200 with this title for projects it cannot show (deleted, private, unknown id).
    if (/n[aã]o foi poss[ií]vel acessar a p[aá]gina/i.test(pageTitle)) {
      throw new SourceNotFoundError(`The site reports the project page as not accessible (page title: "${pageTitle}").`);
    }
    throw new SourceResponseError(
      `Project page has no recognizable project data (page title: "${pageTitle}"). ` +
        'The project may not exist or the markup changed.',
    );
  }

  const canonicalUrl = $('link[rel="canonical"]').attr('href');
  if (!canonicalUrl) {
    throw new SourceResponseError('Project page has no canonical link; the markup may have changed.');
  }

  const info = new Map<string, string>();
  let deadlineRaw: string | undefined;
  for (const row of $('.info-adicionais tr').toArray()) {
    const label = normalizeLabel($(row).find('th').text());
    const cell = $(row).find('td').first();
    if (!label) continue;
    info.set(label, collapse(cell.text()));
    if (label === 'tempo restante') deadlineRaw = cell.attr('cp-datetime');
  }
  const field = (label: string): string | null => info.get(label) || null;

  const exclusiveFlag = $('.box-project-view-principal .flags img[alt="Projeto exclusivo"]').first();
  const exclusiveLabel = collapse(exclusiveFlag.attr('title') ?? '') || null;
  const publishedRaw = collapse($('span.icon-published').first().text()) || null;
  const skills = [
    ...new Set(
      $('.container-habilidades a.habilidade')
        .toArray()
        .map((el) => collapse($(el).text()))
        .filter(Boolean),
    ),
  ];

  return {
    title,
    canonicalUrl,
    description: blockText($('.project-description').first().html()),
    publishedAt: publishedRaw ? absoluteBrazilianDateToIso(publishedRaw) : null,
    publishedRaw,
    category: field('categoria'),
    subcategory: field('subcategoria'),
    experienceLevel: field('nivel de experiencia'),
    budgetRaw: field('orcamento'),
    visibility: field('visibilidade'),
    minimumValueRaw: field('valor minimo'),
    proposalCount: toCount(field('propostas')),
    interestedCount: toCount(field('interessados')),
    deadlineAt: epochMsToIso(deadlineRaw),
    skills,
    statusCode,
    statusLabel: collapse($('button[class*="status-"]').first().text()) || null,
    canSubmitProposal:
      $('a[href^="/project/bid/"]')
        .toArray()
        .some((link) => /enviar proposta/i.test($(link).text())),
    exclusive: exclusiveFlag.length > 0,
    exclusiveLabel,
    exclusiveCountdownSeconds: parseExclusiveCountdownSeconds(exclusiveLabel),
  };
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Lowercase, accent-free label so "Nível de experiência:" matches "nivel de experiencia". */
function normalizeLabel(text: string): string {
  return collapse(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/:$/, '')
    .toLowerCase();
}

/** Converts an HTML fragment with <br> line breaks into plain text with newlines. */
function blockText(fragment: string | null): string {
  if (!fragment) return '';
  const text = load(fragment.replace(/<br\s*\/?>/gi, '\n'), null, false).text();
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function epochMsToIso(raw: string | undefined): string | null {
  if (!raw || !/^\d{12,13}$/.test(raw)) return null;
  const date = new Date(Number(raw));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * "dd/mm/yyyy às HH:mm", shown in Brasília time (UTC-3, no daylight saving since 2019).
 * Relative forms ("hoje às 14:56") and older dates return null instead of being guessed.
 */
function absoluteBrazilianDateToIso(text: string): string | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})\D+(\d{2}):(\d{2})$/.exec(text);
  if (!match) return null;
  const [, day, month, year, hour, minute] = match;
  if (Number(year) < 2019) return null;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:00-03:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function matchCount(text: string, pattern: RegExp): number | null {
  const value = pattern.exec(text)?.[1];
  return value === undefined ? null : Number(value);
}

function toCount(value: string | null): number | null {
  return value !== null && /^\d+$/.test(value) ? Number(value) : null;
}
