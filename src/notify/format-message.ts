import type { FilterDecision, FilterResult } from '../domain/filter-result.js';
import type { Opportunity } from '../domain/opportunity.js';
import { escapeHtml, excerpt, safeHttpUrl } from './html.js';
import { describeClientBudget } from './present.js';
import { translateReason } from './translate-reasons.js';

export { escapeHtml } from './html.js';

export const TEST_MESSAGE = '🎯 Job Sniper online.';

const DECISION_HEADER: Record<FilterDecision, string> = {
  shortlist: '🟢 SELECIONADA',
  review: '🟡 PARA REVISAR',
  skip: '⚪ DESCARTADA',
};

export interface FormatOptions {
  /** Display names by sourceId; unknown ids are shown as they are. */
  sourceLabels?: Readonly<Record<string, string>>;
}

/**
 * Short pt-BR message for an opportunity that has no AI analysis (first notification by the basic filter).
 * One message; never includes the description.
 */
export function formatOpportunityMessage(opportunity: Opportunity, filter: FilterResult, options: FormatOptions = {}): string {
  const source = options.sourceLabels?.[opportunity.sourceId] ?? opportunity.sourceId;
  const category = [opportunity.category, opportunity.subcategory].filter(Boolean).join(' / ') || 'não informada';
  const reasons = filter.reasons.map(translateReason).join('; ');
  const keywords = filter.matchedKeywords.length > 0 ? filter.matchedKeywords.join(', ') : 'nenhuma';

  const lines = [
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
