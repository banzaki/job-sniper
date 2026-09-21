import type { FilterResult } from '../domain/filter-result.js';
import type { EmploymentType, Opportunity } from '../domain/opportunity.js';
import type { InterestProfile } from '../profile/interest-profile.js';
import { normalizeText, padWords } from '../text.js';
import { classifyLocation, descriptionRestrictsLocation } from './location.js';

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
 * Opportunities without an employmentType (sources of projects) are returned untouched.
 */
export function applyEngagementPolicy(base: FilterResult, opportunity: Opportunity, profile: InterestProfile): FilterResult {
  const type = opportunity.employmentType;
  if (type === undefined || base.decision === 'skip') return base;

  const skip = (reason: string): FilterResult => ({ ...base, decision: 'skip', reasons: [reason, ...base.reasons] });

  if (NOT_ALERTED_TYPES.includes(type)) return skip(`employment type: ${TYPE_LABEL[type]} (not sent automatically)`);

  const outside = outsideCategory(opportunity, profile);
  if (outside) return skip(`category "${outside}" is not technology`);

  const location = classifyLocation(opportunity.locationRequirement);
  if (location.verdict === 'incompatible') return skip(`location "${location.raw}" excludes residents of Brazil`);

  if (type === 'freelance' && looksLikeTeamRole(opportunity)) return skip('reads like an ongoing team position, not a defined project');

  const caveats: string[] = [];
  const info: string[] = [];

  if (type === 'unknown') caveats.push('employment type not stated');
  else if (type === 'other') caveats.push(`employment type "${String(opportunity.sourceMetadata.jobTypeRaw ?? 'other')}" is not recognized`);
  else info.push(`employment type: ${TYPE_LABEL[type]}`);

  if (location.verdict === 'unknown') caveats.push('location not stated');
  else if (location.verdict === 'ambiguous') caveats.push(`location "${location.raw}" is ambiguous for a resident of Brazil`);
  else info.push(`location "${location.raw}" is compatible with residence in Brazil`);
  if (location.verdict === 'compatible' && descriptionRestrictsLocation(opportunity.description)) {
    caveats.push('description mentions a location or work-authorization requirement');
  }

  const title = padWords(normalizeText(opportunity.title));
  const senior = SENIOR_TITLE.find((word) => title.includes(padWords(word)));
  if (senior) caveats.push(`seniority in the title: ${senior}`);

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
    /^employment type (not stated|".*" is not recognized)/,
    /^seniority in the title/,
    /^conflicting or advanced scope|^only weak signals|^no strong technical signal|^status could not be confirmed|is outside the profile|^broad category/,
  ];
  for (const pattern of order) {
    const found = reasons.find((reason) => pattern.test(reason));
    if (found) return found;
  }
  return null;
}
