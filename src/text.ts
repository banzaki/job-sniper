/** Lowercase, accent-free, punctuation-free ("&" reads as "e"), single-spaced. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' e ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Surrounding spaces turn a substring test into a whole-word test. */
export function padWords(normalized: string): string {
  return ` ${normalized} `;
}
