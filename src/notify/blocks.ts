import type { FilterDecision, FilterResult } from '../domain/filter-result.js';
import type { Opportunity } from '../domain/opportunity.js';
import { competitionTier, strongSignalCount } from '../filter/ranking.js';
import { mainCaveat } from '../filter/engagement-policy.js';
import { formatBrasiliaTime } from './layout.js';
import { translateReason } from './translate-reasons.js';

/** The classification of an alert that comes from the deterministic filter alone. */
export const CLASSIFICATION: Record<FilterDecision, string> = {
  shortlist: '🟢 BOA OPORTUNIDADE',
  review: '🟡 VALE REVISAR',
  skip: '⚪ DESCARTADA',
};

/**
 * How well the opportunity fits the profile according to the CURRENT deterministic filter (not an AI score):
 * a shortlist with two or more strong skills is high, any other shortlist medium; a review with a strong skill is
 * medium, otherwise low.
 */
export function compatibilityLabel(filter: FilterResult): 'alta' | 'média' | 'baixa' {
  const strong = strongSignalCount(filter);
  if (filter.decision === 'shortlist') return strong >= 2 ? 'alta' : 'média';
  return strong >= 1 ? 'média' : 'baixa';
}

/** Restricted access, worded as an estimate that must be confirmed; null when the opportunity is not restricted. */
export function restrictedAccessText(opportunity: Opportunity, now: Date): string | null {
  const { access } = opportunity;
  if (access.kind !== 'premium_only') return null;
  const opens = access.publicAt ? formatBrasiliaTime(access.publicAt) : null;
  if (access.publicAt && opens && Date.parse(access.publicAt) <= now.getTime()) {
    return `Acesso restrito na última consulta; a liberação estimada (${opens}) já passou. Confirmar no site.`;
  }
  return opens
    ? `Acesso restrito na última consulta. Liberação estimada: ${opens} (Brasília); confirmar no site.`
    : 'Acesso restrito na última consulta; horário de liberação desconhecido. Confirmar no site.';
}

/**
 * The single main caveat of a basic alert, in this order: restricted access, project language, advanced scope, high
 * competition, then the most relevant stored reason (location, type, seniority, skills only in tags, weak signals).
 */
export function basicAttention(opportunity: Opportunity, filter: FilterResult, now: Date): string | null {
  const restricted = restrictedAccessText(opportunity, now);
  if (restricted) return restricted;
  const language = filter.reasons.find((reason) => reason.startsWith('project language'));
  if (language) return capitalize(translateReason(language));
  const advanced = filter.reasons.find((reason) => reason.startsWith('conflicting or advanced scope'));
  if (advanced) return capitalize(translateReason(advanced));
  if (opportunity.proposalCount !== null && opportunity.employmentType !== undefined && competitionTier(opportunity) === 2) {
    return `Concorrência alta: ${opportunity.proposalCount} propostas já enviadas.`;
  }
  const caveat = mainCaveat(filter.reasons);
  return caveat ? capitalize(translateReason(caveat)) : null;
}

/** The profile skills the filter found as strong signals, at most four (a long list adds nothing). */
export function relevantSkills(filter: FilterResult, max = 4): string[] {
  const reason = filter.reasons.find((entry) => entry.startsWith('strong signals: '));
  return reason ? reason.slice('strong signals: '.length).split(',').map((term) => term.trim()).filter((term) => term !== '').slice(0, max) : [];
}

/** A sentence for the reader: a capital letter first and a full stop at the end. */
const capitalize = (text: string): string => {
  if (text === '') return text;
  const sentence = `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  return /[.!?…]$/.test(sentence) ? sentence : `${sentence}.`;
};
