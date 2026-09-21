import type { KeywordRule } from '../profile/interest-profile.js';
import { normalizeText, padWords } from '../text.js';

/** The canonical terms of the rules that appear (as whole words) in an already normalized and padded text. */
export function findTerms(paddedText: string, rules: readonly KeywordRule[]): string[] {
  return rules
    .filter((rule) => {
      let text = paddedText;
      for (const phrase of rule.except ?? []) {
        text = text.split(padWords(normalizeText(phrase))).join(' ');
      }
      return [rule.term, ...(rule.aliases ?? [])].some((spelling) => text.includes(padWords(normalizeText(spelling))));
    })
    .map((rule) => rule.term);
}
