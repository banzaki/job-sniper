import type { FilterDecision, FilterResult } from '../domain/filter-result.js';
import type { MatchAnalysis } from '../domain/match-analysis.js';
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
  /** Reference time for "estimated opening time has passed" (defaults to now). */
  now?: Date;
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

const RECOMMENDATION_HEADER: Record<MatchAnalysis['recommendation'], string> = {
  apply: '🟢 APPLY',
  review: '🟡 REVIEW',
  wait: '🕒 WAIT — PREMIUM ONLY',
  skip: '🔴 SKIP',
};

const AI_LIMITS = { fit: 500, skills: 250, risks: 400, rationale: 200, preview: 500, filter: 120 };

export type AnalysisMessageMode = 'enriched' | 'update';

/**
 * Telegram message for an AI analysis. "enriched" replaces the basic message of a first notification;
 * "update" follows one already sent (or an opportunity the basic filter skipped) and says so.
 * Always short, escaped, and bounded well below Telegram's limit; never includes the description.
 */
export function formatAnalysisMessage(
  opportunity: Opportunity,
  filter: FilterResult,
  analysis: MatchAnalysis,
  mode: AnalysisMessageMode,
  options: FormatOptions = {},
): string {
  const source = options.sourceLabels?.[opportunity.sourceId] ?? opportunity.sourceId;
  const join = (items: readonly string[], max: number): string => truncate(items.join(', '), max) || '-';

  const lines = [RECOMMENDATION_HEADER[analysis.recommendation]];
  if (mode === 'update') lines.push('🤖 AI update on an opportunity already notified or filtered before');
  lines.push(
    '',
    `<b>${escapeHtml(truncate(opportunity.title, LIMITS.title))}</b>`,
    `Source: ${escapeHtml(source)}`,
    `Fit score: ${analysis.score}/100 (technical fit, not a success probability) · Confidence: ${analysis.confidence}`,
    `Skills: ${escapeHtml(describeVerification(analysis))}`,
    `Filter (${escapeHtml(filter.ruleVersion)}): ${escapeHtml(filter.decision)}`,
    `Access: ${escapeHtml(describeAccess(opportunity.access, analysis, options.now ?? new Date()))}`,
    `Matches: ${escapeHtml(join(analysis.matchedSkills, AI_LIMITS.skills))}`,
    `Missing: ${escapeHtml(join(analysis.missingSkills, AI_LIMITS.skills))}`,
    `Risks: ${escapeHtml(join(analysis.risks, AI_LIMITS.risks))}`,
    `Effort: ${analysis.effort.minHours}–${analysis.effort.maxHours} h · Complexity: ${analysis.complexity}`,
    `Price: ${escapeHtml(formatPrice(analysis))}`,
    `Why: ${escapeHtml(truncate(analysis.technicalFit, AI_LIMITS.fit))}`,
    '',
    'Proposal draft:',
    `<i>${escapeHtml(truncatePreserveLines(analysis.proposal.text, AI_LIMITS.preview))}</i>`,
  );
  const link = safeHttpUrl(opportunity.url);
  if (link) lines.push('', `<a href="${escapeHtml(link)}">Open opportunity</a>`);
  return lines.join('\n');
}

function describeVerification(analysis: MatchAnalysis): string {
  const { verification } = analysis;
  if (verification.status === 'verified') {
    return `all essential skills verified (${truncate(verification.confirmed.join(', '), AI_LIMITS.skills)})`;
  }
  const gaps = [...verification.unverified, ...verification.learning, ...verification.notCovered];
  return gaps.length > 0
    ? `essential skills NOT verified by the candidate: ${truncate(gaps.join(', '), AI_LIMITS.skills)}. Review before applying.`
    : 'NOT verified: the analysis lists no essential skill. Review before applying.';
}

function describeAccess(access: Opportunity['access'], analysis: MatchAnalysis, now: Date): string {
  if (access.kind === 'public') return 'public when fetched. Verify availability before applying.';
  if (access.kind === 'unknown') return 'unknown. Verify availability before applying.';

  const publicAt = access.publicAt ? Date.parse(access.publicAt) : Number.NaN;
  if (!Number.isNaN(publicAt) && publicAt <= now.getTime()) {
    return 'restricted when fetched; the estimated opening time has passed, but availability was not re-checked. Verify availability before applying.';
  }
  const opens = access.publicAt ? formatLocalTime(access.publicAt) : null;
  const restricted = analysis.actionability.status === 'restricted' ? 'restricted (premium only)' : 'restricted';
  return opens
    ? `${restricted}; estimated to open to everyone at ${opens}. Verify availability before applying.`
    : `${restricted}; opening time unknown. Verify availability before applying.`;
}

/** Brasília time, since that is where the candidate reads it. Invalid input yields null, never a guess. */
function formatLocalTime(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const formatted = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
  return `${formatted} (Brasília)`;
}

function formatPrice(analysis: MatchAnalysis): string {
  const money = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
  const { min, max, rationale } = analysis.price;
  return `R$ ${money.format(min)}–${money.format(max)} (${truncate(rationale, AI_LIMITS.rationale)})`;
}

function truncatePreserveLines(text: string, maxLength: number): string {
  const trimmed = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength - 1).trimEnd()}…`;
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
