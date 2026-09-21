import { normalizeText, padWords } from '../text.js';

/**
 * Can a person who lives in Brazil take a job that says this about where the candidate must be?
 *  - compatible:   the text names Brazil, Latin/South America, the Americas, or the whole world
 *  - incompatible: it names only other countries or regions (for example "USA Only")
 *  - ambiguous:    anything else ("Remote", a time zone, "Worldwide except ...", unknown words)
 *  - unknown:      nothing was published
 * "Remote" is never read as "worldwide".
 */
export type LocationVerdict = 'compatible' | 'incompatible' | 'ambiguous' | 'unknown';

/** Naming one of these means the region that includes Brazil is welcome. */
const INCLUDES_BRAZIL = ['brazil', 'brasil', 'latam', 'latin america', 'south america', 'americas'];
/** Naming one of these alone means "anywhere", but only when no specific place is also named. */
const WORLDWIDE = ['worldwide', 'anywhere', 'global', 'all countries', 'around the world'];
const OTHER_PLACES = [
  'usa', 'us', 'u s', 'united states', 'canada', 'north america', 'uk', 'united kingdom', 'england', 'scotland', 'ireland',
  'europe', 'european union', 'eu', 'emea', 'germany', 'france', 'spain', 'italy', 'netherlands', 'poland', 'portugal',
  'sweden', 'norway', 'denmark', 'finland', 'switzerland', 'austria', 'belgium', 'czech republic', 'romania', 'ukraine',
  'turkey', 'india', 'pakistan', 'philippines', 'asia', 'apac', 'china', 'japan', 'singapore', 'australia', 'new zealand',
  'africa', 'nigeria', 'kenya', 'south africa', 'middle east', 'israel', 'uae', 'mexico', 'argentina', 'colombia', 'chile',
];
/** Words that turn an otherwise open text into something that needs a human look. */
const QUALIFIER = /\b(except|excluding|excl|not|outside|no)\b/;
const TIME_ZONE = /\b(est|edt|cst|cdt|pst|pdt|cet|cest|utc|gmt|timezone|time zone|overlap)\b/;

export interface LocationAssessment {
  verdict: LocationVerdict;
  /** The text as published, or null. */
  raw: string | null;
}

const mentions = (padded: string, terms: readonly string[]): boolean => terms.some((term) => padded.includes(padWords(term)));

export function classifyLocation(raw: string | null | undefined): LocationAssessment {
  const text = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
  if (text === null) return { verdict: 'unknown', raw: null };

  const padded = padWords(normalizeText(text));
  const includesBrazil = mentions(padded, INCLUDES_BRAZIL);
  const worldwide = mentions(padded, WORLDWIDE);
  const otherPlaces = mentions(padded, OTHER_PLACES);
  const caution = QUALIFIER.test(normalizeText(text)) || TIME_ZONE.test(normalizeText(text));

  if (includesBrazil) return { verdict: caution ? 'ambiguous' : 'compatible', raw: text };
  if (worldwide && !otherPlaces) return { verdict: caution ? 'ambiguous' : 'compatible', raw: text };
  if (otherPlaces && !worldwide) return { verdict: 'incompatible', raw: text };
  return { verdict: 'ambiguous', raw: text };
}

/** A requirement stated inside the description, when the location field itself looks fine. */
const DESCRIPTION_RESTRICTIONS: readonly RegExp[] = [
  /\b(must|need to|required to|have to)\b.{0,20}\b(located|based|reside|residing|live|living|resident)\b.{0,15}\b(in|within)\b.{0,12}\b(us|usa|u s|united states|uk|united kingdom|eu|europe|canada|germany|france|spain|india|australia)\b/,
  /\b(us|usa|u s|united states) (citizens?|residents?|based|only)\b/,
  /\b(work authori[sz]ation|authori[sz]ed to work (in|within)|eligible to work (in|within)|right to work (in|within)|visa sponsorship)\b/,
];

export function descriptionRestrictsLocation(description: string): boolean {
  const text = normalizeText(description);
  return DESCRIPTION_RESTRICTIONS.some((pattern) => pattern.test(text));
}
