import type { FilterResult } from '../domain/filter-result.js';
import type { EmploymentType, Opportunity } from '../domain/opportunity.js';
import type { InterestProfile } from '../profile/interest-profile.js';
import { normalizeText, padWords } from '../text.js';
import { budgetInUsd, formatUsd } from './budget.js';
import { findTerms } from './keyword-match.js';
import { classifyLocation, descriptionRestrictsLocation } from './location.js';
import { MAX_PROPOSALS_FOR_SHORTLIST, VERY_CROWDED_PROPOSALS } from './ranking.js';
import { veryShortDeadlineHours } from './scope-risk.js';

/** How much of the description counts as "the start": where a project states what it needs delivered. */
const DESCRIPTION_LEAD_LENGTH = 500;

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
 * Rules for sources that publish JOBS (an engagement type and a required location) instead of projects. They run
 * AFTER the skill/category rules and can only lower the outcome, never raise it:
 *  - full time, part time, internship and contract   -> skip (stored, not alerted in this version)
 *  - a category that is not technology                -> skip (even with a skill word in the text)
 *  - freelance that reads like a continuing team role -> skip
 *  - type missing or not recognized                   -> at most review, never shown as freelance
 *  - location that excludes residents of Brazil       -> skip
 *  - location ambiguous, missing, or restricted in the description -> at most review
 *  - a senior title                                   -> at most review
 *  - a freelance project with more than 60 proposals  -> at most review (crowded: never "a good opportunity"); above
 *                                                       150 it is a review with the lowest priority, never a skip
 *  - a freelance main task that is not technical      -> skip (payroll, story writing... even with a skill tag)
 *  - a freelance main task that is unclear            -> at most review (no technical deliverable in the title or
 *                                                       the start of the description, or title and text disagree)
 *  - a budget whose top is under the USD floor, a range that crosses it, or no reliable USD conversion -> at most
 *    review (the floors are floors for a SHORTLIST, never a reason to drop a technical opportunity)
 *  - a very short deadline (24 hours or less) or a transactional scope (payments, checkout) -> at most review
 *  - a project language outside the profile languages -> at most review
 *  - a strong skill that appears only in the skill tags, never in the title or description -> at most review
 * Opportunities without an employmentType (sources of projects) are returned untouched.
 */
export function applyEngagementPolicy(base: FilterResult, opportunity: Opportunity, profile: InterestProfile): FilterResult {
  const type = opportunity.employmentType;
  if (type === undefined || base.decision === 'skip') return base;

  const skip = (reason: string): FilterResult => ({ ...base, decision: 'skip', reasons: [reason, ...base.reasons] });

  if (NOT_ALERTED_TYPES.includes(type)) return skip(`employment type: ${TYPE_LABEL[type]} (not sent automatically)`);

  const outside = outsideCategory(opportunity, profile);
  if (outside) return skip(`category "${outside}" is not technology`);

  // The main task has to be technical: tags and passing mentions do not count (see judgeMainTask).
  const mainTask = type === 'freelance' ? judgeMainTask(opportunity, profile) : null;
  if (mainTask?.verdict === 'skip') return skip(mainTask.reason);

  // Budget, competition, deadline and scope never remove a relevant project: they limit it to a review (see below).
  const budget = type === 'freelance' ? judgeBudget(opportunity, profile) : null;

  // A source that publishes no location requirement at all (a projects marketplace) has nothing to judge here.
  const location = opportunity.locationRequirement === undefined ? null : classifyLocation(opportunity.locationRequirement);
  if (location?.verdict === 'incompatible') return skip(`location "${location.raw}" excludes residents of Brazil`);

  if (type === 'freelance' && looksLikeTeamRole(opportunity)) return skip('reads like an ongoing team position, not a defined project');

  const caveats: string[] = [];
  const info: string[] = [];

  if (mainTask?.verdict === 'unclear') caveats.push(mainTask.reason);
  if (budget && budget.verdict !== 'ok') caveats.push(budget.reason);
  if (type === 'freelance' && opportunity.proposalCount !== null && opportunity.proposalCount > MAX_PROPOSALS_FOR_SHORTLIST) {
    caveats.push(
      opportunity.proposalCount > VERY_CROWDED_PROPOSALS
        ? `very crowded project (${opportunity.proposalCount} proposals): at most a review, lowest priority`
        : `crowded project (${opportunity.proposalCount} proposals): at most a review`,
    );
  }
  if (type === 'freelance') caveats.push(...scopeRisks(opportunity, profile));

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

  const decision = caveats.length > 0 && base.decision === 'shortlist' ? 'review' : base.decision;
  return { ...base, decision, reasons: [...caveats, ...info, ...base.reasons] };
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
  const text = padWords(normalizeText(`${opportunity.title}\n${opportunity.description}`));
  return profile.strongSignals.some((rule) => {
    let scanned = text;
    for (const phrase of rule.except ?? []) scanned = scanned.split(padWords(normalizeText(phrase))).join(' ');
    return [rule.term, ...(rule.aliases ?? [])].some((spelling) => scanned.includes(padWords(normalizeText(spelling))));
  });
}

type Judgement = { verdict: 'ok' } | { verdict: 'skip' | 'unclear'; reason: string };

/**
 * Is the MAIN task technical? Judged from the title and the start of the description, where a project says what it
 * needs delivered; the skill tags and mentions deep in the text prove nothing (a payroll job can list "HTML").
 *  - the title names a non-technical task and no technical deliverable    -> skip, unless the start of the description
 *    describes a technical deliverable and names no non-technical task (then title and text disagree: unclear)
 *  - no technical deliverable in the title or the start of the description -> skip when the start names a
 *    non-technical task, otherwise unclear
 * A profile without this vocabulary judges nothing.
 */
function judgeMainTask(opportunity: Opportunity, profile: InterestProfile): Judgement {
  const deliverables = profile.deliverableSignals ?? [];
  const offTopic = profile.offTopicTasks ?? [];
  if (deliverables.length === 0 && offTopic.length === 0) return { verdict: 'ok' };

  const title = padWords(normalizeText(opportunity.title));
  const lead = padWords(normalizeText(opportunity.description.slice(0, DESCRIPTION_LEAD_LENGTH)));
  const titleTech = findTerms(title, deliverables).length > 0;
  const leadTech = findTerms(lead, deliverables).length > 0;
  const titleOff = findTerms(title, offTopic)[0];
  const leadOff = findTerms(lead, offTopic)[0];

  if (titleTech) return { verdict: 'ok' };
  if (titleOff) {
    // The start of the description names non-technical work too: a technical word beside it is incidental.
    if (leadTech && leadOff === undefined) return { verdict: 'unclear', reason: `title names non-technical work ("${titleOff}") but the description starts with a technical deliverable` };
    return { verdict: 'skip', reason: `main task is not technical: "${titleOff}" in the title and no technical deliverable in the title or the start of the description` };
  }
  if (leadTech) return { verdict: 'ok' };
  if (leadOff) return { verdict: 'skip', reason: `main task is not technical: "${leadOff}" at the start of the description and no technical deliverable in the title or there` };
  return { verdict: 'unclear', reason: 'technical deliverable is not clear in the title or the start of the description' };
}

type BudgetJudgement = { verdict: 'ok' } | { verdict: 'low' | 'crosses' | 'unconvertible'; reason: string };

/**
 * The USD equivalent of the range against the profile floor, which is a floor for a SHORTLIST: a bottom at or over it
 * passes, a range that crosses it (bottom under, top at or over; a missing bound counts as open) and a top under it are
 * both at most a review. A currency with no reliable rate is at most a review: no value is invented. No budget, or one
 * that is neither fixed nor hourly, is not judged.
 */
function judgeBudget(opportunity: Opportunity, profile: InterestProfile): BudgetJudgement {
  const floors = profile.budgetFloors;
  if (!floors) return { verdict: 'ok' };
  const usd = budgetInUsd(opportunity);
  if (usd.status === 'none') return { verdict: 'ok' };
  if (usd.status === 'unconvertible') {
    return { verdict: 'unconvertible', reason: usd.currency === '' ? 'budget currency not stated: no reliable USD conversion' : `budget currency "${usd.currency}" has no reliable USD conversion` };
  }
  const hourly = usd.kind === 'hourly';
  const floor = hourly ? floors.hourlyUsd : floors.fixedUsd;
  const unit = hourly ? '/h' : '';
  const bottom = usd.minUsd ?? 0; // an unknown bottom could be anything
  const top = usd.maxUsd ?? Number.POSITIVE_INFINITY; // an unknown top could be anything
  if (top < floor) {
    return { verdict: 'low', reason: `${hourly ? 'hourly rate' : 'fixed budget'} of about US$${formatUsd(top)}${unit} is below the US$${floor}${unit} floor for a shortlist` };
  }
  if (bottom < floor) {
    const shown = `${usd.minUsd === null ? '?' : formatUsd(usd.minUsd)} to ${usd.maxUsd === null ? '?' : formatUsd(usd.maxUsd)}`;
    return { verdict: 'crosses', reason: `${hourly ? 'hourly' : 'fixed'} budget range of about US$${shown}${unit} crosses the US$${floor}${unit} floor: at most a review` };
  }
  return { verdict: 'ok' };
}

/** A very short deadline and a transactional scope: real projects, but risky, so at most a review. */
function scopeRisks(opportunity: Opportunity, profile: InterestProfile): string[] {
  const risks: string[] = [];
  const text = `${opportunity.title}
${opportunity.description}`;
  const hours = veryShortDeadlineHours(text);
  if (hours !== null) risks.push(`very short deadline (about ${hours} hours): at most a review`);
  const transactional = findTerms(padWords(normalizeText(text)), profile.transactionalScope ?? [])[0];
  if (transactional) risks.push('transactional scope (payments or checkout): at most a review');
  return risks;
}

function looksLikeTeamRole(opportunity: Opportunity): boolean {
  const text = normalizeText(`${opportunity.title}\n${opportunity.description}`);
  return TEAM_ROLE.some((pattern) => pattern.test(text));
}

/**
 * The single most relevant caveat among stored reasons, in this order: location, engagement type, seniority, then
 * anything the skill rules said. Stored reasons are English data; the caller translates them for display.
 */
export function mainCaveat(reasons: readonly string[]): string | null {
  const order: RegExp[] = [
    /^location .*(ambiguous|not stated)|^location not stated$|^description mentions/,
    /^employment type (not stated|".*" is not recognized)|^project language/,
    /^title names non-technical work|^technical deliverable is not clear/,
    / is below the US\$\d+(\/h)? floor for a shortlist$/,
    /^(very )?crowded project/,
    /^very short deadline|^transactional scope/,
    /^seniority in the title/,
    /^strong skills appear only as tags/,
    /^budget currency|budget range of about/,
    /^conflicting or advanced scope|^only weak signals|^no strong technical signal|^status could not be confirmed|is outside the profile|^broad category/,
  ];
  for (const pattern of order) {
    const found = reasons.find((reason) => pattern.test(reason));
    if (found) return found;
  }
  return null;
}
