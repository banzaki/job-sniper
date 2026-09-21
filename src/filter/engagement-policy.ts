import type { FilterResult } from '../domain/filter-result.js';
import type { EmploymentType, Opportunity } from '../domain/opportunity.js';
import type { InterestProfile } from '../profile/interest-profile.js';
import type { ExchangeRateLookup } from '../storage/exchange-rate-store.js';
import { normalizeText, padWords } from '../text.js';
import { budgetInUsd, formatUsd } from './budget.js';
import { findTerms } from './keyword-match.js';
import { classifyLocation, descriptionRestrictsLocation } from './location.js';
import { CROWDED_PROPOSALS, VERY_CROWDED_PROPOSALS } from './ranking.js';
import { DESCRIPTION_LEAD_LENGTH, transactionalCentral, veryShortDeadlineHours } from './scope-risk.js';

export { mainCaveat } from './caveats.js';

/** A description shorter than this says too little to call the scope clear. */
const CLEAR_DESCRIPTION_MIN_LENGTH = 150;
/** A description longer than this is a large scope even without a large-scope word. */
const LARGE_DESCRIPTION_LENGTH = 4000;

/** What the policy may need besides the opportunity: the evaluation time and the cached exchange rates. */
export interface PolicyContext {
  now: Date;
  rates?: ExchangeRateLookup;
}

const TYPE_LABEL: Record<EmploymentType, string> = {
  freelance: 'freelance',
  contract: 'contract',
  full_time: 'full time',
  part_time: 'part time',
  internship: 'internship',
  other: 'other',
  unknown: 'unknown',
};

/**
 * Version 1 looks for freelance technology PROJECTS with a defined deliverable. These types are stored but never
 * alerted: permanent and partial positions, internships, and "contract", which says nothing about a defined project.
 */
const NOT_ALERTED_TYPES: readonly EmploymentType[] = ['full_time', 'part_time', 'internship', 'contract'];

const SENIOR_TITLE = ['senior', 'sr', 'staff', 'principal', 'lead', 'head', 'architect', 'director', 'manager', 'vp'];

/** Wording of a continuing position inside a team, as opposed to a project with a defined end. */
const TEAM_ROLE: readonly RegExp[] = [
  /\b(join|joining) (our|the|my|a) (\w+ ){0,3}team\b/,
  /\bteam member\b/,
  /\b(long term|ongoing|permanent|indefinite)\b/,
  /\b(integrar|fazer parte d[aeo]s?) (\w+ ){0,2}(equipe|time)\b/,
];

/**
 * Rules for sources that publish an engagement type (Freelancer.com, Remotive). They run AFTER the skill/category rules and
 * only lower the outcome, except the last step, which may name an excellent match. Technical compatibility is judged
 * apart from attractiveness:
 *
 *  SKIP  (irrelevant, not technology, out of scope or incompatible; never notified)
 *   - full time, part time, internship and contract, and a freelance job that reads like a continuing team role
 *   - a category that is not technology; a main task that is not technical (payroll, story writing, chat support, ads...)
 *   - a central skill the profile does not offer (another language, native mobile...)
 *   - a location that excludes residents of Brazil
 *  REVIEW (a real doubt or gap; caps a shortlist)
 *   - a main task that is unclear, or an essential skill outside the profile beside an available one
 *   - a strong skill named only in the skill tags, a senior title, an advanced scope (already in the skill rules)
 *   - a very short deadline (24 hours or less) or a main delivery that is transactional (payments, checkout, ticketing)
 *   - a type, location or language that is missing, ambiguous or outside the profile
 *  SHORTLIST (technically compatible)
 *   - a low or crossing budget, or a lot of competition, are caveats that lower the ranking; they never cap or remove
 *  TOP MATCH (excellent match: shortlist plus all of)
 *   - a strong skill named in the title or the start of the description; a small or medium scope; a description clear
 *     enough; a budget whose bottom fully reaches the floor, in USD or in a currency with a fresh rate (24 hours); at
 *     most 60 proposals when they are published
 *
 * Opportunities without an employmentType (sources of projects) are returned untouched.
 */
export function applyEngagementPolicy(
  base: FilterResult,
  opportunity: Opportunity,
  profile: InterestProfile,
  context: PolicyContext = { now: new Date() },
): FilterResult {
  const type = opportunity.employmentType;
  if (type === undefined || base.decision === 'skip') return base;

  const skip = (reason: string): FilterResult => ({ ...base, decision: 'skip', reasons: [reason, ...base.reasons] });

  if (NOT_ALERTED_TYPES.includes(type)) return skip(`employment type: ${TYPE_LABEL[type]} (not sent automatically)`);

  const outside = outsideCategory(opportunity, profile);
  if (outside) return skip(`category "${outside}" is not technology`);

  // The main task has to be technical and its central skill available: tags and passing mentions do not count.
  const mainTask = type === 'freelance' ? judgeMainTask(opportunity, profile) : null;
  if (mainTask?.verdict === 'skip') return skip(mainTask.reason);
  const centralSkill = type === 'freelance' ? judgeCentralSkill(opportunity, profile) : null;
  if (centralSkill?.verdict === 'skip') return skip(centralSkill.reason);

  // A source that publishes no location requirement at all (a projects marketplace) has nothing to judge here.
  const location = opportunity.locationRequirement === undefined ? null : classifyLocation(opportunity.locationRequirement);
  if (location?.verdict === 'incompatible') return skip(`location "${location.raw}" excludes residents of Brazil`);

  if (type === 'freelance' && looksLikeTeamRole(opportunity)) return skip('reads like an ongoing team position, not a defined project');

  const caveats: string[] = []; // doubts about technical compatibility: they cap a shortlist at review
  const notes: string[] = []; // attractiveness: they lower the ranking and warn, but never cap or remove
  const info: string[] = [];

  if (mainTask?.verdict === 'unclear') caveats.push(mainTask.reason);
  if (centralSkill?.verdict === 'unclear') caveats.push(centralSkill.reason);
  if (type === 'freelance') caveats.push(...scopeRisks(opportunity, profile));

  const budget = type === 'freelance' ? judgeBudget(opportunity, profile, context) : null;
  if (budget && budget.verdict !== 'ok' && budget.verdict !== 'unconvertible') notes.push(budget.reason);
  if (budget?.verdict === 'unconvertible') info.push(budget.reason);
  if (type === 'freelance' && opportunity.proposalCount !== null && opportunity.proposalCount > CROWDED_PROPOSALS) {
    notes.push(
      opportunity.proposalCount > VERY_CROWDED_PROPOSALS
        ? `very crowded project (${opportunity.proposalCount} proposals): lowest priority in its group`
        : `crowded project (${opportunity.proposalCount} proposals): lowers the ranking`,
    );
  }

  if (type === 'unknown') caveats.push('employment type not stated');
  else if (type === 'other') caveats.push(`employment type "${String(opportunity.sourceMetadata.jobTypeRaw ?? 'other')}" is not recognized`);
  else info.push(`employment type: ${TYPE_LABEL[type]}`);

  if (location) {
    if (location.verdict === 'unknown') caveats.push('location not stated');
    else if (location.verdict === 'ambiguous') caveats.push(`location "${location.raw}" is ambiguous for a resident of Brazil`);
    else info.push(`location "${location.raw}" is compatible with residence in Brazil`);
  }
  if ((location === null || location.verdict === 'compatible') && descriptionRestrictsLocation(opportunity.description)) {
    caveats.push('description mentions a location or work-authorization requirement');
  }

  const language = typeof opportunity.sourceMetadata.language === 'string' ? (opportunity.sourceMetadata.language.trim().toLowerCase().split(/[-_]/)[0] ?? '') : '';
  if (language !== '' && profile.languages && !profile.languages.includes(language)) {
    caveats.push(`project language "${language}" is not one of the profile languages`);
  }

  const title = padWords(normalizeText(opportunity.title));
  const senior = SENIOR_TITLE.find((word) => title.includes(padWords(word)));
  if (senior) caveats.push(`seniority in the title: ${senior}`);

  // Skill tags are often generic ("HTML" on a translation job): a shortlist needs the skill named in the text itself.
  if (base.decision === 'shortlist' && !strongSkillInText(opportunity, profile)) {
    caveats.push('strong skills appear only as tags, not in the title or description');
  }

  let decision: FilterResult['decision'] = caveats.length > 0 && base.decision === 'shortlist' ? 'review' : base.decision;
  if (decision === 'shortlist' && type === 'freelance' && qualifiesForTopMatch(opportunity, profile, budget)) {
    decision = 'top_match';
    info.unshift('top match: strong skill up front, small or medium scope, clear description, budget above the floor and little competition');
  }
  return { ...base, decision, reasons: [...caveats, ...notes, ...info, ...base.reasons] };
}

/** The label of a category the profile lists as outside its interests (and not also as relevant), or null. */
function outsideCategory(opportunity: Opportunity, profile: InterestProfile): string | null {
  const labels = [opportunity.subcategory, opportunity.category].filter((value): value is string => value !== null && value !== undefined);
  const within = (list: readonly string[]): string | null => {
    const normalized = new Set(list.map(normalizeText));
    return labels.find((label) => normalized.has(normalizeText(label))) ?? null;
  };
  if (within(profile.directCategories) || within(profile.broadCategories)) return null;
  return within(profile.excludedCategories);
}

/** Does the title or description itself name one of the profile's strong skills (aliases and exceptions included)? */
function strongSkillInText(opportunity: Opportunity, profile: InterestProfile): boolean {
  return findTerms(padWords(normalizeText(`${opportunity.title}\n${opportunity.description}`)), profile.strongSignals).length > 0;
}

type Judgement = { verdict: 'ok' } | { verdict: 'skip' | 'unclear'; reason: string };

/**
 * Is the MAIN task technical? Judged from the title and the start of the description, where a project says what it
 * needs delivered; the skill tags and mentions deep in the text prove nothing (a payroll job can list "HTML").
 *  - a marketing task (ads, SEO) in the title with no strong skill named there              -> skip
 *  - the title names a non-technical task and no technical deliverable                     -> skip, unless the start of
 *    the description describes a technical deliverable and names no non-technical task (then title and text disagree:
 *    unclear)
 *  - no technical deliverable in the title or the start of the description                 -> skip when the start names a
 *    non-technical task, otherwise unclear
 * A profile without this vocabulary judges nothing.
 */
function judgeMainTask(opportunity: Opportunity, profile: InterestProfile): Judgement {
  const deliverables = profile.deliverableSignals ?? [];
  const marketing = profile.offTopicUnlessStrong ?? [];
  const offTopic = [...(profile.offTopicTasks ?? []), ...marketing];
  if (deliverables.length === 0 && offTopic.length === 0) return { verdict: 'ok' };

  const title = padWords(normalizeText(opportunity.title));
  const lead = padWords(normalizeText(opportunity.description.slice(0, DESCRIPTION_LEAD_LENGTH)));

  const titleMarketing = findTerms(title, marketing)[0];
  if (titleMarketing && findTerms(title, profile.strongSignals).length === 0) {
    return { verdict: 'skip', reason: `main task is not technical: "${titleMarketing}" in the title and no strong technical skill named there` };
  }

  const titleTech = findTerms(title, deliverables).length > 0;
  const leadTech = findTerms(lead, deliverables).length > 0;
  const titleOff = findTerms(title, offTopic)[0];
  const leadOff = findTerms(lead, offTopic)[0];

  if (titleTech) return { verdict: 'ok' };
  if (titleOff) {
    // A generic word ("website chat window") does not rescue a non-technical title: only one of the profile's own skills
    // at the start of the description does, and only when that start names no non-technical work too (else it is incidental).
    const leadStrong = findTerms(lead, profile.strongSignals).length > 0;
    if (leadStrong && leadOff === undefined) return { verdict: 'unclear', reason: `title names non-technical work ("${titleOff}") but the description starts with a technical deliverable` };
    return { verdict: 'skip', reason: `main task is not technical: "${titleOff}" in the title and no technical deliverable in the title or the start of the description` };
  }
  if (leadTech) return { verdict: 'ok' };
  if (leadOff) return { verdict: 'skip', reason: `main task is not technical: "${leadOff}" at the start of the description and no technical deliverable in the title or there` };
  return { verdict: 'unclear', reason: 'technical deliverable is not clear in the title or the start of the description' };
}

/**
 * Is the CENTRAL skill one the profile does not offer (another language, native mobile, games...)? Named in the title it
 * is a skip; named only at the start of the description, a skip too unless an available skill is named beside it. An
 * available (strong) skill beside it makes it a doubt (unclear), never a skip: the work may still be executable.
 */
function judgeCentralSkill(opportunity: Opportunity, profile: InterestProfile): Judgement {
  const unavailable = profile.unavailableSkills ?? [];
  if (unavailable.length === 0) return { verdict: 'ok' };
  const title = padWords(normalizeText(opportunity.title));
  const lead = padWords(normalizeText(opportunity.description.slice(0, DESCRIPTION_LEAD_LENGTH)));
  const inTitle = findTerms(title, unavailable)[0];
  const inLead = findTerms(lead, unavailable)[0];
  const strongInTitle = findTerms(title, profile.strongSignals).length > 0;
  const strongInLead = findTerms(lead, profile.strongSignals).length > 0;
  if (inTitle) {
    return strongInTitle
      ? { verdict: 'unclear', reason: `essential skill outside the profile: "${inTitle}" beside an available skill` }
      : { verdict: 'skip', reason: `central skill outside the profile: "${inTitle}" in the title` };
  }
  if (inLead) {
    return strongInTitle || strongInLead
      ? { verdict: 'unclear', reason: `essential skill outside the profile: "${inLead}" beside an available skill` }
      : { verdict: 'skip', reason: `central skill outside the profile: "${inLead}" at the start of the description` };
  }
  return { verdict: 'ok' };
}

type BudgetJudgement =
  | { verdict: 'ok'; reachesFloor: boolean }
  | { verdict: 'low' | 'crosses'; reason: string; reachesFloor: false }
  | { verdict: 'unconvertible'; reason: string; reachesFloor: false };

/**
 * The USD equivalent of the range against the profile floor. Only a range whose bottom fully reaches the floor is fine for
 * a top match; a top under the floor ("low") and a range that crosses it (a missing bound counts as open) are caveats
 * that lower the ranking. A currency with no fresh rate is not converted: it only withholds the top match. No budget, or
 * one that is neither fixed nor hourly, is not judged (and cannot be a top match).
 */
function judgeBudget(opportunity: Opportunity, profile: InterestProfile, context: PolicyContext): BudgetJudgement {
  const floors = profile.budgetFloors;
  if (!floors) return { verdict: 'ok', reachesFloor: false };
  const usd = budgetInUsd(opportunity, context.now, context.rates);
  if (usd.status === 'none') return { verdict: 'ok', reachesFloor: false };
  if (usd.status === 'unconvertible') {
    const reason = usd.currency === '' ? 'budget currency not stated: not a top match' : `budget currency "${usd.currency}" has no fresh USD conversion: not a top match`;
    return { verdict: 'unconvertible', reason, reachesFloor: false };
  }
  const hourly = usd.kind === 'hourly';
  const floor = hourly ? floors.hourlyUsd : floors.fixedUsd;
  const unit = hourly ? '/h' : '';
  const bottom = usd.minUsd ?? 0; // an unknown bottom could be anything
  const top = usd.maxUsd ?? Number.POSITIVE_INFINITY; // an unknown top could be anything
  if (top < floor) {
    return { verdict: 'low', reachesFloor: false, reason: `${hourly ? 'hourly rate' : 'fixed budget'} of about US$ ${formatUsd(top)}${unit} is below the US$ ${floor}${unit} floor` };
  }
  if (bottom < floor) {
    const shown = `${usd.minUsd === null ? '?' : formatUsd(usd.minUsd)}–${usd.maxUsd === null ? '?' : formatUsd(usd.maxUsd)}`;
    return { verdict: 'crosses', reachesFloor: false, reason: `${hourly ? 'hourly' : 'fixed'} budget range of about US$ ${shown}${unit} crosses the US$ ${floor}${unit} floor` };
  }
  return { verdict: 'ok', reachesFloor: usd.minUsd !== null };
}

/** A very short deadline and a main delivery that is transactional: real projects, but risky, so at most a review. */
function scopeRisks(opportunity: Opportunity, profile: InterestProfile): string[] {
  const risks: string[] = [];
  const hours = veryShortDeadlineHours(`${opportunity.title}\n${opportunity.description}`);
  if (hours !== null) risks.push(`very short deadline (about ${hours} hours): at most a review`);
  if (transactionalCentral(opportunity.title, opportunity.description, profile.transactionalScope)) {
    risks.push('transactional scope (payments or checkout): at most a review');
  }
  return risks;
}

/**
 * A shortlist becomes a top match only when everything that makes it excellent is known: a strong skill in the title or the
 * start of the description, a small or medium scope, a description clear enough, a budget whose bottom fully reaches the
 * floor (in USD, or in a currency with a fresh rate) and at most 60 proposals when the count is published. Doubts were
 * already removed: a shortlist has no caveat.
 */
function qualifiesForTopMatch(opportunity: Opportunity, profile: InterestProfile, budget: BudgetJudgement | null): boolean {
  if (!budget?.reachesFloor) return false;
  if (opportunity.proposalCount !== null && opportunity.proposalCount > CROWDED_PROPOSALS) return false;
  const title = padWords(normalizeText(opportunity.title));
  const lead = padWords(normalizeText(opportunity.description.slice(0, DESCRIPTION_LEAD_LENGTH)));
  if (findTerms(title, profile.strongSignals).length === 0 && findTerms(lead, profile.strongSignals).length === 0) return false;
  if (opportunity.description.trim().length < CLEAR_DESCRIPTION_MIN_LENGTH) return false;
  if (opportunity.description.length > LARGE_DESCRIPTION_LENGTH) return false;
  const text = padWords(normalizeText(`${opportunity.title}\n${opportunity.description}`));
  return findTerms(text, profile.largeScopeSignals ?? []).length === 0;
}

function looksLikeTeamRole(opportunity: Opportunity): boolean {
  const text = normalizeText(`${opportunity.title}\n${opportunity.description}`);
  return TEAM_ROLE.some((pattern) => pattern.test(text));
}
