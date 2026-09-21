import type { FilterResult } from '../domain/filter-result.js';
import type { Opportunity } from '../domain/opportunity.js';

/** Above this many proposals a project is stored but never alerted automatically (too crowded to be worth a message). */
export const MAX_PROPOSALS_FOR_ALERT = 150;

/**
 * How crowded a project already is, as an alert priority (lower is better):
 *   0 high     up to 20 proposals
 *   1 normal   21 to 60
 *   2 reduced  61 to 150
 * Only a source that publishes engagement types and proposal counts (a projects marketplace) has one; every other
 * opportunity is "normal", so its order is decided by the other criteria alone.
 */
export function competitionTier(opportunity: Opportunity): 0 | 1 | 2 {
  const proposals = opportunity.proposalCount;
  if (opportunity.employmentType === undefined || proposals === null) return 1;
  if (proposals <= 20) return 0;
  if (proposals <= 60) return 1;
  return 2;
}

const DECISION_ORDER: Record<FilterResult['decision'], number> = { shortlist: 0, review: 1, skip: 2 };
const brasiliaDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });

/** The publication day (YYYY-MM-DD, Brasília time for a real instant); '' when nothing reliable is known (ranks last). */
export function publicationDay(opportunity: Opportunity): string {
  const instant = opportunity.publishedAt ? Date.parse(opportunity.publishedAt) : Number.NaN;
  if (!Number.isNaN(instant)) return brasiliaDate.format(new Date(instant));
  const day = opportunity.sourceMetadata.publishedDay;
  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : '';
}

/** How many strong skills the deterministic filter found (its stored reason "strong signals: A, B"). */
export function strongSignalCount(filter: FilterResult): number {
  const reason = filter.reasons.find((entry) => entry.startsWith('strong signals: '));
  return reason ? reason.slice('strong signals: '.length).split(',').filter((term) => term.trim() !== '').length : 0;
}

export interface Ranked {
  opportunity: Opportunity;
  filter: FilterResult;
}

/**
 * The order in which pending alerts are sent (negative: a before b):
 *  1. shortlist before review;
 *  2. the crowding tier (fewer proposals first, for sources that publish them);
 *  3. the most recent publication day first (unknown last);
 *  4. more strong skills;
 *  5. fewer proposals (unknown last);
 *  6. the stable id ("source:id"), so the order never depends on insertion order.
 */
export function compareForAlert(a: Ranked, b: Ranked): number {
  const byDecision = DECISION_ORDER[a.filter.decision] - DECISION_ORDER[b.filter.decision];
  if (byDecision !== 0) return byDecision;
  const byTier = competitionTier(a.opportunity) - competitionTier(b.opportunity);
  if (byTier !== 0) return byTier;
  const dayA = publicationDay(a.opportunity);
  const dayB = publicationDay(b.opportunity);
  if (dayA !== dayB) return dayA === '' ? 1 : dayB === '' ? -1 : dayA < dayB ? 1 : -1;
  const byStrong = strongSignalCount(b.filter) - strongSignalCount(a.filter);
  if (byStrong !== 0) return byStrong;
  const proposalsA = a.opportunity.proposalCount ?? Number.POSITIVE_INFINITY;
  const proposalsB = b.opportunity.proposalCount ?? Number.POSITIVE_INFINITY;
  if (proposalsA !== proposalsB) return proposalsA < proposalsB ? -1 : 1;
  const idA = `${a.opportunity.sourceId}:${a.opportunity.externalId}`;
  const idB = `${b.opportunity.sourceId}:${b.opportunity.externalId}`;
  return idA < idB ? -1 : idA > idB ? 1 : 0;
}
