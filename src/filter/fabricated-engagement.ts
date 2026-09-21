import type { FabricatedEngagementVocabulary } from '../profile/interest-profile.js';
import { normalizeText, padWords } from '../text.js';
import { findTerms } from './keyword-match.js';

/** A stated daily volume of ads, views, clicks or impressions ("about 1,000 banner ads every day", "a daily target of 500 clicks"). */
const DAILY_VOLUME = /\b\d+(?: \d{3})*\s+(?:\w+\s+){0,2}(?:ads?|banners?|impressions?|views?|clicks?|visits?)\b.{0,40}\b(?:per|a|every|each|por|ao|todo)\s+(?:day|dia)\b|\bdaily\s+(?:target|goal|quota)\s+of\s+\d+(?: \d{3})*\s+\w*\s*(?:impressions?|views?|clicks?)\b|\b(?:meta|alvo)\s+diaria\s+de\s+\d+(?: \d{3})*/;

/**
 * Is the CENTRAL goal to fabricate views, clicks, impressions, traffic or engagement artificially? Judged by what a sentence
 * asks for, never by an isolated word (a tracking pixel, an analytics dashboard or an ad-verification tool are ordinary work):
 *  - a sentence that names a fake or inflated result together with the metric ("fake clicks", "a click farm"), or
 *  - a sentence that asks an automatic means to boost or generate the metric ("a bot to boost views"), or
 *  - a sentence that asks an automatic means to load, watch or click things and count the metric, AND the text also asks to
 *    look natural to the platform (rotating proxies, avoiding detection) or states a daily volume to reach.
 * Returns the metric that is being fabricated, or null.
 */
export function fabricatedEngagement(title: string, description: string, vocabulary: FabricatedEngagementVocabulary | undefined): string | null {
  if (!vocabulary) return null;
  const text = `${title}.\n${description}`;
  const sentences = text.split(/[.!?;\n•]+/).map((sentence) => padWords(normalizeText(sentence))).filter((sentence) => sentence.trim() !== '');
  const wholeText = normalizeText(text);
  const evasionAnywhere = sentences.some((sentence) => findTerms(sentence, vocabulary.evasion).length > 0);
  const volumeStated = DAILY_VOLUME.test(wholeText);

  for (const sentence of sentences) {
    const metric = findTerms(sentence, vocabulary.metrics)[0];
    if (metric === undefined) continue;
    const automatic = findTerms(sentence, vocabulary.automation).length > 0;
    if (findTerms(sentence, vocabulary.explicit).length > 0) return metric;
    if (automatic && findTerms(sentence, vocabulary.purposes).length > 0) return metric;
    if (automatic && findTerms(sentence, vocabulary.actions).length > 0 && (evasionAnywhere || volumeStated)) return metric;
  }
  return null;
}
