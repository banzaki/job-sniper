import type { FilterDecision, FilterResult } from '../domain/filter-result.js';
import type { Opportunity, OpportunityBudget } from '../domain/opportunity.js';

export const TEST_MESSAGE = '🎯 Job Sniper online.';

const DECISION_HEADER: Record<FilterDecision, string> = {
  shortlist: '🟢 SHORTLIST',
  review: '🟡 REVIEW',
  skip: '⚪ SKIP',
};

const LIMITS = { title: 200, category: 120, reasons: 350, keywords: 200 };

export interface FormatOptions {
  /** Display names by sourceId; unknown ids are shown as they are. */
  sourceLabels?: Readonly<Record<string, string>>;
}

/** Escapes text for Telegram's HTML parse mode. Every externally sourced value goes through this. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Short, phone-friendly message for one opportunity. Never includes the description. */
export function formatOpportunityMessage(
  opportunity: Opportunity,
  filter: FilterResult,
  options: FormatOptions = {},
): string {
  const source = options.sourceLabels?.[opportunity.sourceId] ?? opportunity.sourceId;
  const category = [opportunity.category, opportunity.subcategory].filter(Boolean).join(' / ') || 'n/a';
  const keywords = filter.matchedKeywords.length > 0 ? filter.matchedKeywords.join(', ') : '-';

  const lines = [
    DECISION_HEADER[filter.decision],
    '',
    `<b>${escapeHtml(truncate(opportunity.title, LIMITS.title))}</b>`,
    `Source: ${escapeHtml(source)}`,
    `Category: ${escapeHtml(truncate(category, LIMITS.category))}`,
    `Match: ${escapeHtml(truncate(filter.reasons.join('; '), LIMITS.reasons))}`,
    `Keywords: ${escapeHtml(truncate(keywords, LIMITS.keywords))}`,
    `Status: ${escapeHtml(opportunity.status)}`,
    `Budget: ${escapeHtml(formatBudget(opportunity.budget))}`,
    `Proposals: ${opportunity.proposalCount ?? 'n/a'}`,
    `Interested: ${opportunity.interestedCount ?? 'n/a'}`,
  ];
  const link = safeHttpUrl(opportunity.url);
  if (link) {
    lines.push('', `<a href="${escapeHtml(link)}">Open opportunity</a>`);
  }
  return lines.join('\n');
}

function formatBudget(budget: OpportunityBudget | null): string {
  if (!budget || budget.kind === 'unknown') return 'n/a';
  if (budget.min === null && budget.max === null) return budget.kind;
  return `${budget.kind} ${budget.currency} ${budget.min ?? '?'}-${budget.max ?? '?'}`;
}

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function truncate(text: string, maxLength: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= maxLength ? flat : `${flat.slice(0, maxLength - 1).trimEnd()}…`;
}
