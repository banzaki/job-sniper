import type { FilterResult } from '../domain/filter-result.js';
import type { Opportunity } from '../domain/opportunity.js';
import { caveatCount, mainTaskIsClear } from './caveats.js';

/** Above this many proposals a project is crowded: a caveat that lowers its ranking, and never a top match. */
export const CROWDED_PROPOSALS = 60;
/** Above this many proposals a project is still relevant, but it goes last in its own group. */
export const VERY_CROWDED_PROPOSALS = 150;
const HIGH_PRIORITY_PROPOSALS = 20;

/**
 * How crowded a project already is (from the proposals the source publishes; unknown is "normal"):
 *   0 high          up to 20 proposals
 *   1 normal        21 to 60
 *   2 reduced       61 to 150
 *   3 very crowded  more than 150 (relevant, but last in its own group)
 */
export function competitionTier(opportunity: Opportunity): 0 | 1 | 2 | 3 {
  const proposals = opportunity.proposalCount;
  if (proposals === null) return 1;
  if (proposals <= HIGH_PRIORITY_PROPOSALS) return 0;
  if (proposals <= CROWDED_PROPOSALS) return 1;
  if (proposals <= VERY_CROWDED_PROPOSALS) return 2;
  return 3;
}

/**
 * How the budget compares with the floors, from the reasons the filter stored (lower is better):
 *   0 reaches the floor, or nothing to judge   1 range crosses the floor   2 no fresh USD conversion   3 below the floor
 */
export function budgetRank(filter: FilterResult): 0 | 1 | 2 | 3 {
  if (filter.reasons.some((reason) => / is below the US\$ \d+(\/h)? floor$/.test(reason))) return 3;
  if (filter.reasons.some((reason) => /^budget currency /.test(reason))) return 2;
  if (filter.reasons.some((reason) => / budget range of about US\$ /.test(reason))) return 1;
  return 0;
}

const DECISION_ORDER: Record<FilterResult['decision'], number> = { top_match: 0, shortlist: 1, review: 2, skip: 3 };
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
 * The order in which pending alerts are sent (negative: a before b). Globally: top match, then shortlist, then review.
 * Inside each group:
 *  1. a very crowded project (more than 150 proposals) goes last;
 *  2. a main task that is clearly relevant first (no doubt about the task itself);
 *  3. the most recent publication day first (unknown last);
 *  4. fewer caveats;
 *  5. the better budget (reaches the floor, crosses it, no fresh conversion, below it);
 *  6. fewer proposals (unknown last);
 *  7. more strong skills;
 *  8. the stable id ("source:id"), so the order never depends on insertion order.
 */
export function compareForAlert(a: Ranked, b: Ranked): number {
  const byDecision = DECISION_ORDER[a.filter.decision] - DECISION_ORDER[b.filter.decision];
  if (byDecision !== 0) return byDecision;
  const veryCrowded = (entry: Ranked): number => (competitionTier(entry.opportunity) === 3 ? 1 : 0);
  const byCrowd = veryCrowded(a) - veryCrowded(b);
  if (byCrowd !== 0) return byCrowd;
  const unclear = (entry: Ranked): number => (mainTaskIsClear(entry.filter.reasons) ? 0 : 1);
  const byTask = unclear(a) - unclear(b);
  if (byTask !== 0) return byTask;
  const dayA = publicationDay(a.opportunity);
  const dayB = publicationDay(b.opportunity);
  if (dayA !== dayB) return dayA === '' ? 1 : dayB === '' ? -1 : dayA < dayB ? 1 : -1;
  const byCaveats = caveatCount(a.filter.reasons) - caveatCount(b.filter.reasons);
  if (byCaveats !== 0) return byCaveats;
  const byBudget = budgetRank(a.filter) - budgetRank(b.filter);
  if (byBudget !== 0) return byBudget;
  const proposalsA = a.opportunity.proposalCount ?? Number.POSITIVE_INFINITY;
  const proposalsB = b.opportunity.proposalCount ?? Number.POSITIVE_INFINITY;
  if (proposalsA !== proposalsB) return proposalsA < proposalsB ? -1 : 1;
  const byStrong = strongSignalCount(b.filter) - strongSignalCount(a.filter);
  if (byStrong !== 0) return byStrong;
  const idA = `${a.opportunity.sourceId}:${a.opportunity.externalId}`;
  const idB = `${b.opportunity.sourceId}:${b.opportunity.externalId}`;
  return idA < idB ? -1 : idA > idB ? 1 : 0;
}
