import type { FilterResult } from '../domain/filter-result.js';
import type { Opportunity } from '../domain/opportunity.js';
import type { InterestProfile } from '../profile/interest-profile.js';
import { normalizeText, padWords } from '../text.js';
import { applyEngagementPolicy } from './engagement-policy.js';
import { findTerms } from './keyword-match.js';

/**
 * basic-v3: adds the engagement/location policy for job sources; results for project sources are unchanged.
 * basic-v4: adds the Freelancer.com non-technology categories to the profile and lets the policy handle a source
 * that publishes no location; results for 99Freelas are unchanged.
 * basic-v5: a freelance project with more than 150 proposals is skipped and one in a language outside the profile is at
 * most a review; results for 99Freelas are unchanged.
 * basic-v6: for freelance projects, the main task must be technical (a non-technical main task is skipped, an unclear
 * one is at most a review), a budget range that crosses the USD floor and a project with 61 to 150 proposals are at
 * most a review; results for 99Freelas are unchanged.
 * basic-v7: a low budget, a lot of competition (even above 150 proposals), a very short deadline and a transactional
 * scope no longer skip a technically relevant project: they limit it to a review (the floors are floors for a
 * shortlist, not for eligibility). `skip` is kept for what is irrelevant, closed, not technology or incompatible.
 */
export const FILTER_RULE_VERSION = 'basic-v7';

interface CategoryInfo {
  direct: string | null;
  broad: string | null;
  excluded: string | null;
  /** A specific category on none of the lists. */
  other: string | null;
  /** Missing, or a label like "Other" that says nothing about the work. */
  vague: boolean;
}

/**
 * Deterministic, explainable filter. Signals come from the text (title, description, skills):
 * strong (proves fit), weak (generic words) and conflicting (advanced or unrelated scope).
 *
 *  0. cancelled / closed -> skip
 *  1. At least one strong signal:
 *       any conflicting signal, excluded category or unconfirmed status -> review
 *       otherwise                                                        -> shortlist
 *  2. No strong signal:
 *       excluded category                                          -> skip
 *       directly relevant category:
 *         >= 2 weak signals, no conflict, status open              -> shortlist
 *         otherwise                                                -> review
 *       weak or conflicting signals, or a broad category           -> review
 *       missing / vague category                                   -> review (doubt favors review)
 *       anything else                                              -> skip
 * A weak signal alone never produces a shortlist.
 *
 * Then, only for sources that publish jobs (an employmentType), the engagement policy may lower the result
 * (see engagement-policy.ts).
 */
export function evaluateOpportunity(
  opportunity: Opportunity,
  profile: InterestProfile,
  now: Date = new Date(),
): FilterResult {
  return applyEngagementPolicy(evaluateSkills(opportunity, profile, now), opportunity, profile);
}

function evaluateSkills(opportunity: Opportunity, profile: InterestProfile, now: Date): FilterResult {
  const meta = { evaluatedAt: now.toISOString(), ruleVersion: FILTER_RULE_VERSION };
  const result = (
    decision: FilterResult['decision'],
    reasons: string[],
    matchedKeywords: string[] = [],
  ): FilterResult => ({ ...meta, decision, reasons, matchedKeywords });

  if (opportunity.status === 'cancelled' || opportunity.status === 'closed') {
    return result('skip', [`status is ${opportunity.status}`]);
  }

  const text = pad(normalize([opportunity.title, opportunity.description, ...opportunity.skills].join('\n')));
  const strong = findTerms(text, profile.strongSignals);
  const weak = findTerms(text, profile.weakSignals);
  const conflicts = findTerms(text, profile.conflictSignals);
  const category = classifyCategory(opportunity, profile);
  const matched = [...strong, ...weak];
  const open = opportunity.status === 'open';

  const notes = {
    strong: strong.length > 0 ? `strong signals: ${strong.join(', ')}` : null,
    weak: weak.length > 0 ? `weak signals: ${weak.join(', ')}` : null,
    conflicts: conflicts.length > 0 ? `conflicting or advanced scope: ${conflicts.join(', ')}` : null,
    unconfirmed: open ? null : 'status could not be confirmed as open',
    direct: category.direct ? `category "${category.direct}" is directly relevant` : null,
  };
  const compact = (items: (string | null)[]): string[] => items.filter((item): item is string => item !== null);

  if (strong.length > 0) {
    const problems = compact([
      notes.conflicts,
      category.excluded ? `category "${category.excluded}" is outside the profile` : null,
      notes.unconfirmed,
    ]);
    const reasons = compact([notes.strong, notes.direct, notes.weak, ...problems]);
    return problems.length > 0 ? result('review', reasons, matched) : result('shortlist', reasons, matched);
  }

  if (category.excluded) {
    return result('skip', [
      `category "${category.excluded}" is outside the profile and there are no strong signals`,
    ]);
  }

  if (category.direct) {
    const reasons = compact([notes.direct, notes.weak, notes.conflicts, notes.unconfirmed]);
    if (weak.length >= 2 && conflicts.length === 0 && open) {
      return result('shortlist', [...reasons, 'several compatible weak signals support the category'], matched);
    }
    return result('review', [...reasons, 'no strong technical signal'], matched);
  }

  if (weak.length > 0 || conflicts.length > 0 || category.broad) {
    const reasons = compact([
      weak.length > 0 && conflicts.length === 0 ? `only weak signals (${weak.join(', ')}), not enough on their own` : notes.weak,
      notes.conflicts,
      category.broad ? `broad category "${category.broad}" without a strong skill` : null,
      notes.unconfirmed,
    ]);
    return result('review', reasons, matched);
  }

  if (category.vague) {
    const label = opportunity.category ?? opportunity.subcategory;
    return result('review', [
      `no interest signals, but the category is ${label ? `non-specific ("${label}")` : 'missing'}`,
    ]);
  }

  return result('skip', [
    `category "${category.other}" is not on the interest list and no interest signals were found`,
  ]);
}

function classifyCategory(opportunity: Opportunity, profile: InterestProfile): CategoryInfo {
  const labels = [opportunity.subcategory, opportunity.category].filter(
    (value): value is string => value !== null,
  );
  const within = (list: readonly string[]): string | null => {
    const normalized = new Set(list.map(normalize));
    return labels.find((label) => normalized.has(normalize(label))) ?? null;
  };

  const direct = within(profile.directCategories);
  const broad = within(profile.broadCategories);
  const excluded = direct || broad ? null : within(profile.excludedCategories);
  const vagueLabels = new Set(profile.nonSpecificCategories.map(normalize));
  const specific = labels.filter((label) => !vagueLabels.has(normalize(label)));

  return {
    direct,
    broad,
    excluded,
    other: direct || broad || excluded ? null : (specific.join(' / ') || null),
    vague: specific.length === 0,
  };
}

const normalize = normalizeText;
const pad = padWords;
