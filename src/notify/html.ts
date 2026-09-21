/** Escapes text for Telegram's HTML parse mode. Every externally sourced value goes through this. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Length Telegram counts: characters after entity parsing. Tags are not counted and "&amp;" is one character.
 * UTF-16 code units are used (an emoji counts as 2), which is the conservative reading of the limit.
 */
export function visibleLength(html: string): number {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot);/g, '_').length;
}

/** Telegram accepts at most 4096 characters per message; parts are kept under this safer bound. */
export const TELEGRAM_SAFE_LIMIT = 3800;

/**
 * Splits plain text into pieces of at most `max` characters WITHOUT cutting a sentence when it can be avoided:
 * paragraphs first, then sentences, then words, and only as a last resort by characters (never inside a
 * surrogate pair, so emojis stay whole). No text is dropped and nothing is replaced by an ellipsis.
 * Joining the pieces back (paragraph breaks kept) reproduces the text, whitespace aside.
 */
export function splitPlainText(text: string, max: number): string[] {
  const clean = text.replace(/\r\n?/g, '\n').trim();
  if (clean === '') return [];
  if (clean.length <= max) return [clean];

  const pieces: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current.trim() !== '') pieces.push(current.trim());
    current = '';
  };
  const add = (unit: string, separator: string): void => {
    if (current === '') {
      current = unit;
    } else if ((current + separator + unit).length <= max) {
      current += separator + unit;
    } else {
      flush();
      current = unit;
    }
  };

  for (const paragraph of clean.split(/\n{2,}/)) {
    if (paragraph.length <= max) {
      add(paragraph, '\n\n');
      continue;
    }
    for (const sentence of paragraph.split(/(?<=[.!?…:;])\s+/)) {
      if (sentence.length <= max) {
        add(sentence, ' ');
        continue;
      }
      for (const word of sentence.split(/\s+/)) {
        if (word.length <= max) {
          add(word, ' ');
          continue;
        }
        flush();
        let chunk = '';
        for (const character of Array.from(word)) {
          if ((chunk + character).length > max) {
            pieces.push(chunk);
            chunk = '';
          }
          chunk += character;
        }
        current = chunk;
      }
    }
  }
  flush();
  return pieces;
}

/** Shortens text at a sentence boundary when possible, otherwise at a word, adding an ellipsis only then. */
export function excerpt(text: string, max: number): { text: string; truncated: boolean } {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return { text: flat, truncated: false };
  const window = flat.slice(0, max);
  const sentenceEnd = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
  if (sentenceEnd >= max * 0.5) return { text: window.slice(0, sentenceEnd + 1), truncated: true };
  const wordEnd = window.lastIndexOf(' ');
  return { text: `${window.slice(0, wordEnd > 0 ? wordEnd : max).trimEnd()}…`, truncated: true };
}
