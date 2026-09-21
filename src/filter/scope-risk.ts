import type { TransactionalVocabulary } from '../profile/interest-profile.js';
import { normalizeText, padWords } from '../text.js';
import { findTerms } from './keyword-match.js';

/** How much of the description counts as "the start" (about the first 100 words): where a project states what it needs delivered. */
export const DESCRIPTION_LEAD_LENGTH = 600;


/**
 * Is the MAIN delivery transactional (payments, checkout, subscriptions, ticketing or bookings)? Only then it is an
 * advanced scope for a small project. A shop that merely says customers pay with PayPal is not: a payment word counts
 * when it is in the title, when the start of the description names a strongly transactional delivery, or when it
 * directly follows an implementing verb ("integrate a payment gateway", "fix the billing"). Returns the term that
 * proves it, or null.
 */
export function transactionalCentral(title: string, description: string, vocabulary: TransactionalVocabulary | undefined): string | null {
  if (!vocabulary) return null;
  const paddedTitle = padWords(normalizeText(title));
  const lead = normalizeText(description.slice(0, DESCRIPTION_LEAD_LENGTH));
  const inTitle = findTerms(paddedTitle, vocabulary.titleTerms)[0];
  if (inTitle) return inTitle;
  const central = findTerms(padWords(lead), vocabulary.central)[0];
  if (central) return central;
  const objects = vocabulary.objects.flatMap((rule) => [rule.term, ...(rule.aliases ?? [])]).map(normalizeText);
  const actions = vocabulary.actions.map(normalizeText);
  if (objects.length === 0 || actions.length === 0) return null;
  const implementing = new RegExp(`\\b(?:${actions.join('|')})\\w*(?:\\s+\\w+){0,4}?\\s+(${objects.join('|')})\\b`).exec(lead);
  return implementing?.[1] ?? null;
}

/** A deadline of this many hours or less is extremely short for a real project. */
export const VERY_SHORT_DEADLINE_HOURS = 24;

const WORDS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, 'twenty four': 24,
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, 'vinte e quatro': 24,
};
const NUMBER = `(\\d{1,2}|${Object.keys(WORDS).sort((a, b) => b.length - a.length).join('|')})`;
const HOURS = '(?:hours?|hrs?|horas?)';
/** "within the next five hours", "in 3 hours", "em 5 horas"; not a workload such as "in 10 hours per week". */
const DUE_IN = new RegExp(`\\b(?:within|in|by|under|inside|next|em|dentro de|nas proximas)\\s+(?:the\\s+)?(?:next\\s+)?${NUMBER}\\s+${HOURS}\\b(?!\\s+(?:per|a|each|every|por|na|no)\\s+(?:week|month|day|semana|mes|dia))`);
/** "24 hour turnaround", "a 5 hour deadline". */
const TURNAROUND = new RegExp(`\\b${NUMBER}\\s+${HOURS}\\s+(?:turnaround|deadline|delivery|rush|de prazo)\\b`);

/** The hours of an extremely short deadline stated in the text (24 or fewer), or null when none is stated. */
export function veryShortDeadlineHours(text: string): number | null {
  const normalized = normalizeText(text);
  const found: number[] = [];
  for (const pattern of [DUE_IN, TURNAROUND]) {
    const match = pattern.exec(normalized);
    const raw = match?.[1];
    if (raw === undefined) continue;
    const hours = /^\d+$/.test(raw) ? Number(raw) : WORDS[raw];
    if (hours !== undefined && hours >= 1 && hours <= VERY_SHORT_DEADLINE_HOURS) found.push(hours);
  }
  return found.length > 0 ? Math.min(...found) : null;
}
