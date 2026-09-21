import type { FilterDecision, FilterResult } from '../domain/filter-result.js';
import type { EmploymentType, Opportunity } from '../domain/opportunity.js';
import { mainCaveat } from '../filter/engagement-policy.js';
import { escapeHtml, excerpt, safeHttpUrl, visibleLength } from './html.js';
import { COMPACT_CEILING, describeClientBudget, firstSentence } from './present.js';
import { translateReason } from './translate-reasons.js';

export { escapeHtml } from './html.js';

export const TEST_MESSAGE = '🎯 Job Sniper online.';

const DECISION_HEADER: Record<FilterDecision, string> = {
  shortlist: '🟢 SELECIONADA',
  review: '🟡 PARA REVISAR',
  skip: '⚪ DESCARTADA',
};

const EMPLOYMENT_LABEL: Record<EmploymentType, string> = {
  freelance: 'Freelance',
  contract: 'Contrato',
  full_time: 'Tempo integral',
  part_time: 'Meio período',
  internship: 'Estágio',
  other: 'Outro',
  unknown: 'não informado',
};

export interface FormatOptions {
  /** Display names by sourceId; unknown ids are shown as they are. */
  sourceLabels?: Readonly<Record<string, string>>;
  /** A brief note shown for a source's opportunities (for example a publication delay). */
  sourceNotes?: Readonly<Record<string, string>>;
  /** Marks the message as a visual preview, not a new alert. */
  preview?: boolean;
  /** The moment used to say how long ago something was published. Defaults to the current time. */
  now?: Date;
}

const PREVIEW_LINE = '🧪 <b>PRÉVIA</b> · não é um alerta novo';

/**
 * Short pt-BR message for an opportunity that has no AI analysis (first notification by the basic filter).
 * One message; never includes the description. Opportunities of a jobs source (with an engagement type) get the
 * compact job layout; the project layout below is unchanged.
 */
export function formatOpportunityMessage(opportunity: Opportunity, filter: FilterResult, options: FormatOptions = {}): string {
  if (opportunity.employmentType !== undefined) return formatJobMessage(opportunity, filter, options);

  const source = options.sourceLabels?.[opportunity.sourceId] ?? opportunity.sourceId;
  const category = [opportunity.category, opportunity.subcategory].filter(Boolean).join(' / ') || 'não informada';
  const reasons = filter.reasons.map(translateReason).join('; ');
  const keywords = filter.matchedKeywords.length > 0 ? filter.matchedKeywords.join(', ') : 'nenhuma';

  const lines = [
    ...(options.preview ? [PREVIEW_LINE, ''] : []),
    `<b>${DECISION_HEADER[filter.decision]}</b>`,
    `<b>${escapeHtml(excerpt(opportunity.title, 200).text)}</b>`,
    `📍 ${escapeHtml(source)}`,
    '',
    `Categoria: ${escapeHtml(excerpt(category, 120).text)}`,
    `Motivo: ${escapeHtml(excerpt(reasons, 350).text)}`,
    `Palavras encontradas: ${escapeHtml(excerpt(keywords, 200).text)}`,
    `Situação: ${escapeHtml(opportunity.status === 'open' ? 'aberta' : opportunity.status)}`,
    `Orçamento do cliente: ${escapeHtml(describeClientBudget(opportunity.budget))}`,
    `Propostas: ${opportunity.proposalCount ?? 'não informado'} · Interessados: ${opportunity.interestedCount ?? 'não informado'}`,
  ];
  const link = safeHttpUrl(opportunity.url);
  if (link) lines.push('', `🔗 <a href="${escapeHtml(link)}">Abrir oportunidade</a>`);
  return lines.join('\n');
}

const DAY_MS = 86_400_000;
/** Age is highlighted only for a publication this recent; older or unknown dates get no highlight. */
const RECENT_DAYS = 7;

/**
 * "🆕 Publicada há X dias" for a reliable publication date up to 7 days old; null otherwise. A real instant (with its
 * time zone) is measured in whole elapsed days. A date that came without a time zone only gives its calendar day, so
 * that day is compared with today's date and no time of day is ever shown or assumed. A future or missing date says nothing.
 */
export function recencyLine(opportunity: Opportunity, now: Date): string | null {
  let days: number | null = null;
  const instant = opportunity.publishedAt ? Date.parse(opportunity.publishedAt) : Number.NaN;
  // Rows stored before publishedDay existed still carry the raw text, flagged as having no time zone.
  const meta = opportunity.sourceMetadata;
  const day = meta.publishedDay ?? (meta.publishedTimezone === 'not stated' && typeof meta.publishedRaw === 'string' ? meta.publishedRaw.slice(0, 10) : null);
  if (!Number.isNaN(instant)) {
    days = Math.floor((now.getTime() - instant) / DAY_MS);
  } else if (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
    days = Math.round((Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / DAY_MS);
  }
  if (days === null || days < 0 || days > RECENT_DAYS) return null;
  return days === 0 ? '🆕 Publicada hoje' : `🆕 Publicada há ${days} ${days === 1 ? 'dia' : 'dias'}`;
}

/** Progressively tighter limits, used only when the message would exceed the ceiling. */
const TIERS = [
  { title: 100, company: 40, sentence: 220, caveat: 200, location: 80, pay: 80 },
  { title: 80, company: 30, sentence: 150, caveat: 130, location: 60, pay: 60 },
  { title: 60, company: 20, sentence: 100, caveat: 90, location: 40, pay: 40 },
] as const;

/**
 * One compact message (at most COMPACT_CEILING visible characters) for a job published by a source: title and
 * source, engagement type, required location, pay exactly as published (never converted, never called a budget),
 * a one-sentence summary, the main caveat, a brief source note and the original link. No score, suggested price
 * or proposal appears: none was produced.
 */
function formatJobMessage(opportunity: Opportunity, filter: FilterResult, options: FormatOptions): string {
  const source = options.sourceLabels?.[opportunity.sourceId] ?? opportunity.sourceId;
  const note = options.sourceNotes?.[opportunity.sourceId] ?? null;
  const link = safeHttpUrl(opportunity.url);
  const company = typeof opportunity.sourceMetadata.company === 'string' ? opportunity.sourceMetadata.company : null;
  const type = opportunity.employmentType ?? 'unknown';
  const typeLabel =
    type === 'other' && typeof opportunity.sourceMetadata.jobTypeRaw === 'string' ? opportunity.sourceMetadata.jobTypeRaw : EMPLOYMENT_LABEL[type];
  const caveatReason = mainCaveat(filter.reasons);
  const recency = recencyLine(opportunity, options.now ?? new Date());

  for (const tier of TIERS) {
    const lines: string[] = [];
    if (options.preview) lines.push(PREVIEW_LINE, '');
    lines.push(
      `<b>${DECISION_HEADER[filter.decision]}</b>`,
      `<b>${escapeHtml(excerpt(opportunity.title, tier.title).text)}</b>`,
      `Fonte: ${escapeHtml(source)}${company ? ` · ${escapeHtml(excerpt(company, tier.company).text)}` : ''}`,
      ...(recency ? [recency] : []),
      `Contratação: ${escapeHtml(typeLabel)}`,
      `Localização exigida: ${escapeHtml(opportunity.locationRequirement ? excerpt(opportunity.locationRequirement, tier.location).text : 'não informada')}`,
      `Remuneração (como publicada): ${escapeHtml(opportunity.compensation ? excerpt(opportunity.compensation, tier.pay).text : 'não informada')}`,
    );
    const summary = firstSentence(opportunity.summary ?? opportunity.description, tier.sentence);
    if (summary) lines.push('', escapeHtml(summary));
    if (caveatReason) lines.push('', `⚠️ ${escapeHtml(excerpt(translateReason(caveatReason), tier.caveat).text)}`);
    if (note) lines.push(escapeHtml(note));
    if (link) lines.push('', `🔗 <a href="${escapeHtml(link)}">Abrir na ${escapeHtml(source)}</a>`);

    const text = lines.join('\n');
    if (visibleLength(text) <= COMPACT_CEILING) return text;
  }
  throw new Error(`Message exceeds ${COMPACT_CEILING} characters even in its shortest form.`);
}
