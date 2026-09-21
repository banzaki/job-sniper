import type {
  Actionability,
  Complexity,
  Confidence,
  MatchAnalysis,
  ModelRecommendation,
  Recommendation,
  SkillVerification,
} from '../domain/match-analysis.js';
import type { Opportunity } from '../domain/opportunity.js';
import type { CandidateProfile, CandidateSkill } from '../profile/candidate-profile.js';
import { SKILL_ALIASES } from '../profile/skill-aliases.js';
import { normalizeText, padWords } from '../text.js';
import { analysisVersionFor } from './analyzer.js';
import { AnalysisInvalidOutputError } from './errors.js';

/** The model's answer, checked field by field. It is not an analysis until assembleAnalysis accepts it. */
export interface ModelOutput {
  score: number;
  confidence: Confidence;
  recommendation: ModelRecommendation;
  technicalFit: string;
  /** Skills the delivery essentially depends on. Drives verification, whatever else is listed. */
  essentialSkills: string[];
  matchedSkills: string[];
  missingSkills: string[];
  risks: string[];
  clientQuestions: string[];
  effort: { minHours: number; maxHours: number };
  complexity: Complexity;
  price: { min: number; max: number; rationale: string };
  proposalLanguage: string;
  proposalText: string;
}

const LIMITS = {
  technicalFit: 800,
  rationale: 500,
  listItem: 300,
  listItems: 12,
  questions: 5,
  proposal: 2000,
  hours: 2000,
  brl: 1_000_000,
};

function invalid(message: string): never {
  throw new AnalysisInvalidOutputError(`Invalid model output: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(source: Record<string, unknown>, key: string, maxLength: number, truncate: boolean): string {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') invalid(`"${key}" must be a non-empty string`);
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  if (!truncate) invalid(`"${key}" has ${trimmed.length} characters (limit ${maxLength})`);
  return `${trimmed.slice(0, maxLength - 1).trimEnd()}…`;
}

function choice<T extends string>(source: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const value = source[key];
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) invalid(`"${key}" must be one of ${allowed.join(', ')}`);
  return found;
}

function bounded(source: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`"${key}" must be a number`);
  if (value < min || value > max) invalid(`"${key}" is ${value}, outside ${min}-${max}`);
  return value;
}

function list(source: Record<string, unknown>, key: string, maxItems: number): string[] {
  const value = source[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    invalid(`"${key}" must be an array of strings`);
  }
  return (value as string[])
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .slice(0, maxItems)
    .map((item) => (item.length > LIMITS.listItem ? `${item.slice(0, LIMITS.listItem - 1).trimEnd()}…` : item));
}

function object(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key];
  if (!isRecord(value)) invalid(`"${key}" must be an object`);
  return value;
}

/**
 * Parses and validates the model's JSON. Strict on required fields, enums and numeric ranges;
 * lenient only in trimming empty list items and shortening over-long explanatory text.
 * Anything else throws, so nothing invalid can be stored as a successful analysis.
 */
export function parseModelOutput(raw: string): ModelOutput {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    invalid('the response is not valid JSON');
  }
  if (!isRecord(parsed)) invalid('the response is not a JSON object');

  const effort = object(parsed, 'effort');
  const minHours = bounded(effort, 'minHours', 0, LIMITS.hours);
  const maxHours = bounded(effort, 'maxHours', 0, LIMITS.hours);
  if (maxHours < minHours) invalid('"effort.maxHours" is below "effort.minHours"');

  const price = object(parsed, 'price');
  const minBrl = bounded(price, 'minBrl', 0, LIMITS.brl);
  const maxBrl = bounded(price, 'maxBrl', 0, LIMITS.brl);
  if (maxBrl < minBrl) invalid('"price.maxBrl" is below "price.minBrl"');

  const language = text(parsed, 'proposalLanguage', 12, false);
  if (!/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(language)) invalid('"proposalLanguage" must be a language code such as pt-BR');

  return {
    score: Math.round(bounded(parsed, 'score', 0, 100)),
    confidence: choice(parsed, 'confidence', ['low', 'medium', 'high']),
    recommendation: choice(parsed, 'recommendation', ['apply', 'review', 'skip']),
    technicalFit: text(parsed, 'technicalFit', LIMITS.technicalFit, true),
    essentialSkills: list(parsed, 'essentialSkills', LIMITS.listItems),
    matchedSkills: list(parsed, 'matchedSkills', LIMITS.listItems),
    missingSkills: list(parsed, 'missingSkills', LIMITS.listItems),
    risks: list(parsed, 'risks', LIMITS.listItems),
    clientQuestions: list(parsed, 'clientQuestions', LIMITS.questions),
    effort: { minHours, maxHours },
    complexity: choice(parsed, 'complexity', ['low', 'medium', 'high']),
    price: { min: minBrl, max: maxBrl, rationale: text(price, 'rationale', LIMITS.rationale, true) },
    proposalLanguage: language,
    proposalText: text(parsed, 'proposalText', LIMITS.proposal, false),
  };
}

const MASTERY = /\b(especialista|expert|expertise|s[eê]nior|dom[ií]nio (total|completo|absoluto))\b/i;
const OFF_PLATFORM =
  /https?:\/\/|www\.|\S+@\S+\.\S+|\b(whatsapp|zap|skype|discord|instagram|linkedin|e-?mail)\b|fora da plataforma|por fora|\bpix\b/i;

/**
 * Amounts in reais and dates are ordinary proposal content and were being mistaken for phone numbers
 * ("R$ 800 - 1.500", "2026-09-21"). They are blanked out before phone detection. Amounts are limited to
 * 7 digits so a phone number typed after "R$" is not swallowed.
 */
const AMOUNT = String.raw`(?<!\d)(?:\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d{1,7}(?:,\d{1,2})?)(?!\d)`;
const MONEY = new RegExp(
  String.raw`R\$\s*${AMOUNT}(?:\s*[-–]\s*(?:R\$\s*)?${AMOUNT})?|${AMOUNT}(?:\s*[-–]\s*${AMOUNT})?\s*reais`,
  'gi',
);
const DATES = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g;

/** Real phone formats only: +country, (area) number, area + number with separators, 0800-style, long digit runs, local xxxx-xxxx. */
const PHONE = new RegExp(
  [
    String.raw`\+\d[\d\s().-]{7,}\d`,
    String.raw`\(\d{2,3}\)\s?\d{4,5}[\s.-]?\d{4}`,
    String.raw`\b\d{2,3}[\s.-]\d{4,5}[\s.-]\d{4}\b`,
    String.raw`\b0[3589]00[\s.-]?\d{3}[\s.-]?\d{3,4}\b`,
    String.raw`\b\d{10,13}\b`,
    String.raw`\b\d{4,5}-\d{4}\b`,
  ].join('|'),
);

function containsPhoneNumber(text: string): boolean {
  return PHONE.test(text.replace(MONEY, ' ').replace(DATES, ' '));
}
const YEARS_CLAIM = /\b\d+\s*\+?\s*anos?\s+(de\s+)?(experi[eê]ncia|atuando|no mercado|de mercado|trabalhando)|\bexperi[eê]ncia de \d+/i;
const CERTIFICATION_CLAIM = /\b(sou|possuo|tenho|com)\s+(a\s+)?certifica[cç][aã]o|certificad[oa]\s+(em|pel[oa])|\bsou certificad/i;
const EXPERIENCE_CLAIM =
  /\bportf[oó]lio\b|\b(meus?|minhas?)\s+clientes?\b|\bclientes?\s+anteriores\b|\bprojetos?\s+anteriores\b|\bj[aá]\s+(atendi|trabalhei|entreguei|desenvolvi|fiz|criei)\b/i;

/** Absolute promises. Performance and outcomes depend on hosting, media, third parties and how they are measured. */
const GUARANTEE =
  /\bgarant(o|irei|iremos|imos|e|ida|ido)\b|\bprometo\b|\b100\s*%|\bsem\s+(nenhum\s+)?(erro|falha|bug)s?\b|\bcom certeza\b/i;
/** First-person assertions of competence, which only the owner can make true. */
const COMPETENCE_CLAIM =
  /\b(tenho|possuo)\s+(amplo\s+|s[oó]lido\s+|vasto\s+)?(experi[eê]ncia|dom[ií]nio|conhecimento|profici[eê]ncia)\b|\bdomino\b|\bsou\s+(profici|fluente|expert)/i;

/**
 * Local truthfulness guard for a proposal. Returns every rule the text breaks; empty means acceptable.
 * It is deliberately blunt: a rejected proposal is simply retried later, an invented claim is not undone.
 */
export function checkProposal(proposal: string, candidate: CandidateProfile): string[] {
  const violations: string[] = [];
  if (OFF_PLATFORM.test(proposal) || containsPhoneNumber(proposal)) {
    violations.push('contains a link, e-mail, phone or off-platform contact/payment');
  }
  if (MASTERY.test(proposal)) violations.push('claims mastery or seniority');
  if (CERTIFICATION_CLAIM.test(proposal)) violations.push('claims a certification');
  if (GUARANTEE.test(proposal)) violations.push('makes an absolute guarantee or promise');
  if (candidate.recordedExperience.length === 0) {
    if (COMPETENCE_CLAIM.test(proposal)) violations.push('asserts competence or experience');
    if (YEARS_CLAIM.test(proposal)) violations.push('claims years of experience');
    if (EXPERIENCE_CLAIM.test(proposal)) violations.push('claims past clients, projects or a portfolio');
  }

  const padded = padWords(normalizeText(proposal));
  for (const skill of candidate.skills.filter((entry) => entry.level === 'unavailable')) {
    const mentioned = skillTerms(skill).some((term) => padded.includes(padWords(term)));
    if (mentioned) violations.push(`mentions unavailable skill "${skill.name}"`);
  }
  return violations;
}

function skillTerms(skill: CandidateSkill): string[] {
  const known = SKILL_ALIASES[skill.name] ?? [];
  return [skill.name, ...(skill.aliases ?? []), ...known].map(normalizeText).filter((term) => term !== '');
}

export type SkillStanding = 'confirmed' | 'unverified' | 'learning' | 'notCovered';

/**
 * What the profile says about one skill named by the model. "notCovered" means the profile does not list it
 * as something the candidate has, or lists it as unavailable. Otherwise the strongest level found wins:
 * confirmed, then unverified (interest only), then learning.
 */
export function standingOf(skill: string, candidate: CandidateProfile): SkillStanding {
  const normalized = normalizeText(skill);
  const unavailable = candidate.skills.filter((entry) => entry.level === 'unavailable');
  if (unavailable.some((entry) => skillTerms(entry).some((term) => padWords(normalized).includes(padWords(term))))) {
    return 'notCovered';
  }
  const owners = candidate.skills.filter(
    (entry) =>
      entry.level !== 'unavailable' &&
      skillTerms(entry).some((term) => term.length >= 3 && (normalized.includes(term) || term.includes(normalized))),
  );
  if (owners.length === 0) return 'notCovered';
  if (owners.some((entry) => entry.level === 'confirmed')) return 'confirmed';
  if (owners.some((entry) => entry.level === 'unverified')) return 'unverified';
  return 'learning';
}

interface ReconciledSkills {
  matchedSkills: string[];
  missingSkills: string[];
  verification: SkillVerification;
}

/**
 * Two separate jobs:
 *  - display lists: a "matched" skill must be one the candidate has (anything else moves to missing, so it can
 *    never be shown as a match), and essential skills the profile does not cover are added to missing;
 *  - verification of the ESSENTIAL skills: "verified" only when there is at least one and every one is
 *    confirmed by the owner. One confirmed skill never compensates for another essential one that is
 *    unverified, being learned, or outside the profile.
 */
function reconcileSkills(output: ModelOutput, candidate: CandidateProfile): ReconciledSkills {
  const matchedSkills: string[] = [];
  const demoted: string[] = [];
  for (const skill of output.matchedSkills) {
    if (standingOf(skill, candidate) === 'notCovered') demoted.push(skill);
    else if (!matchedSkills.includes(skill)) matchedSkills.push(skill);
  }

  const essential = [...new Set(output.essentialSkills)];
  const buckets: Record<SkillStanding, string[]> = { confirmed: [], unverified: [], learning: [], notCovered: [] };
  for (const skill of essential) buckets[standingOf(skill, candidate)].push(skill);

  const { confirmed, unverified, learning, notCovered } = buckets;
  const verified = essential.length > 0 && unverified.length + learning.length + notCovered.length === 0;
  const gaps = [
    unverified.length > 0 ? `competence not verified: ${unverified.join(', ')}` : null,
    learning.length > 0 ? `only being learned: ${learning.join(', ')}` : null,
    notCovered.length > 0 ? `not covered by the candidate profile: ${notCovered.join(', ')}` : null,
  ].filter((gap): gap is string => gap !== null);

  return {
    matchedSkills,
    missingSkills: [...new Set([...output.missingSkills, ...demoted, ...notCovered])].slice(0, LIMITS.listItems),
    verification: {
      status: verified ? 'verified' : 'unverified',
      essential,
      confirmed,
      unverified,
      learning,
      notCovered,
      note: verified
        ? null
        : essential.length === 0
          ? 'The model listed no essential skills, so competence cannot be verified. Recommendation capped at "review".'
          : `Essential skills not fully verified (${gaps.join('; ')}). Compatibility depends on confirmation; recommendation capped at "review".`,
    },
  };
}

/**
 * Whether the candidate can act on the opportunity now. Never affects the technical score, and never
 * assumes an opportunity became public just because an estimated time has passed: that needs a fresh check.
 */
export function computeActionability(
  opportunity: Pick<Opportunity, 'sourceId' | 'access'>,
  candidate: CandidateProfile,
  now: Date = new Date(),
): Actionability {
  const { access } = opportunity;
  const base = { publicAt: access.publicAt, refreshBeforeApplying: true } as const;

  if (access.kind === 'public') {
    return { ...base, status: 'actionable', reason: 'Observed as open to every professional when it was fetched.' };
  }
  if (access.kind === 'premium_only') {
    if (candidate.sourceCapabilities[opportunity.sourceId]?.canApplyToPremiumOnly) {
      return { ...base, status: 'actionable', reason: 'The candidate account can apply to restricted opportunities.' };
    }
    if (access.publicAt !== null && Date.parse(access.publicAt) <= now.getTime()) {
      return {
        ...base,
        status: 'unknown',
        reason: 'The estimated opening time has passed, but availability was not re-checked: verify availability before applying.',
      };
    }
    return {
      ...base,
      status: 'restricted',
      reason: access.publicAt
        ? `Restricted access; estimated to open to everyone at ${access.publicAt}.`
        : 'Restricted access; the opening time is unknown.',
    };
  }
  return { ...base, status: 'unknown', reason: 'Access could not be determined: verify availability before applying.' };
}

export interface AssembleContext {
  opportunity: Opportunity;
  candidate: CandidateProfile;
  provider: string;
  model: string;
  modelVersion: string | null;
  now: Date;
}

/**
 * Turns a validated model output into a MatchAnalysis: enforces the truthfulness guard, reconciles
 * matched skills against the candidate profile, and applies the local rules on the recommendation:
 *  - "apply" is only kept when EVERY essential skill is confirmed by the owner (at least one is required);
 *    otherwise it becomes "review", confidence is capped at "medium" and the uncertainty is added to the risks;
 *  - a verified "apply" becomes "wait" when the candidate cannot act on the opportunity yet.
 * Throws AnalysisInvalidOutputError when the proposal breaks a rule.
 */
export function assembleAnalysis(output: ModelOutput, context: AssembleContext): MatchAnalysis {
  const violations = checkProposal(output.proposalText, context.candidate);
  if (violations.length > 0) {
    invalid(`the proposal ${violations.join('; ')}`);
  }

  const actionability = computeActionability(context.opportunity, context.candidate, context.now);
  const skills = reconcileSkills(output, context.candidate);
  const { verification } = skills;

  let recommendation: Recommendation = output.recommendation;
  if (recommendation === 'apply' && verification.status !== 'verified') recommendation = 'review';
  else if (recommendation === 'apply' && actionability.status === 'restricted') recommendation = 'wait';

  return {
    sourceId: context.opportunity.sourceId,
    externalId: context.opportunity.externalId,
    provider: context.provider,
    model: context.model,
    modelVersion: context.modelVersion,
    analysisVersion: analysisVersionFor(context.candidate),
    analyzedAt: context.now.toISOString(),
    score: output.score,
    // Unverified essential skills cannot back a "high" confidence.
    confidence: verification.status !== 'verified' && output.confidence === 'high' ? 'medium' : output.confidence,
    recommendation,
    modelRecommendation: output.recommendation,
    technicalFit: output.technicalFit,
    matchedSkills: skills.matchedSkills,
    verification,
    missingSkills: skills.missingSkills,
    risks: verification.note ? [verification.note, ...output.risks].slice(0, LIMITS.listItems) : output.risks,
    clientQuestions: output.clientQuestions,
    effort: output.effort,
    complexity: output.complexity,
    price: { currency: 'BRL', min: output.price.min, max: output.price.max, rationale: output.price.rationale },
    actionability,
    proposal: { language: output.proposalLanguage, text: output.proposalText, status: 'draft' },
  };
}
