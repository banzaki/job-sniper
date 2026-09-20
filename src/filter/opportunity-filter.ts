import type { FilterResult } from '../domain/filter-result.js';
import type { Opportunity } from '../domain/opportunity.js';
import type { InterestProfile } from '../profile/interest-profile.js';

export const FILTER_RULE_VERSION = 'basic-v1';

/**
 * Deterministic, explainable filter. Order of rules:
 *  1. cancelled / closed                      -> skip
 *  2. relevant category OR interest keywords:
 *       status open                           -> shortlist
 *       status unknown                        -> review
 *  3. no positive signal:
 *       known, specific, irrelevant category  -> skip
 *       category missing or non-specific      -> review (doubt favors review)
 */
export function evaluateOpportunity(
  opportunity: Opportunity,
  profile: InterestProfile,
  now: Date = new Date(),
): FilterResult {
  const meta = { evaluatedAt: now.toISOString(), ruleVersion: FILTER_RULE_VERSION };

  if (opportunity.status === 'cancelled' || opportunity.status === 'closed') {
    return { ...meta, decision: 'skip', reasons: [`status is ${opportunity.status}`], matchedKeywords: [] };
  }

  const matchedKeywords = findKeywords(opportunity, profile);
  const relevantCategory = findRelevantCategory(opportunity, profile);
  const reasons: string[] = [];
  if (matchedKeywords.length > 0) {
    reasons.push(`matched interest terms: ${matchedKeywords.join(', ')}`);
  }
  if (relevantCategory) {
    reasons.push(`category "${relevantCategory}" is on the interest list`);
  }

  if (reasons.length > 0) {
    if (opportunity.status === 'open') {
      return { ...meta, decision: 'shortlist', reasons, matchedKeywords };
    }
    reasons.push('status could not be confirmed as open, so it needs manual review');
    return { ...meta, decision: 'review', reasons, matchedKeywords };
  }

  const category = opportunity.subcategory ?? opportunity.category;
  const specificCategories = [opportunity.category, opportunity.subcategory].filter(
    (value): value is string => value !== null && !isNonSpecific(value, profile),
  );
  if (specificCategories.length > 0) {
    return {
      ...meta,
      decision: 'skip',
      reasons: [
        `category "${specificCategories.join(' / ')}" is not on the interest list and no interest terms were found`,
      ],
      matchedKeywords: [],
    };
  }
  return {
    ...meta,
    decision: 'review',
    reasons: [
      `no interest terms found, but the category is ${category ? `non-specific ("${category}")` : 'missing'}`,
    ],
    matchedKeywords: [],
  };
}

function findKeywords(opportunity: Opportunity, profile: InterestProfile): string[] {
  const text = pad(normalize([opportunity.title, opportunity.description, ...opportunity.skills].join('\n')));
  return profile.keywords
    .filter((rule) =>
      [rule.term, ...(rule.aliases ?? [])].some((spelling) => text.includes(pad(normalize(spelling)))),
    )
    .map((rule) => rule.term);
}

function findRelevantCategory(opportunity: Opportunity, profile: InterestProfile): string | null {
  const relevant = new Set(profile.relevantCategories.map(normalize));
  for (const candidate of [opportunity.category, opportunity.subcategory]) {
    if (candidate !== null && relevant.has(normalize(candidate))) return candidate;
  }
  return null;
}

function isNonSpecific(category: string, profile: InterestProfile): boolean {
  return profile.nonSpecificCategories.map(normalize).includes(normalize(category));
}

/** Lowercase, accent-free, punctuation-free ("&" reads as "e"), single-spaced. */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' e ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Surrounding spaces turn a substring test into a whole-word test. */
function pad(normalized: string): string {
  return ` ${normalized} `;
}
