import { load } from 'cheerio';

/** Tags whose content is never text a person should read. */
const DROPPED = 'script, style, noscript, template, iframe, object, embed, svg, head';
const BLOCKS = 'p, div, section, article, header, footer, ul, ol, table, tr, h1, h2, h3, h4, h5, h6, blockquote, pre';

/**
 * Turns an HTML description into plain text without ever executing or rendering it: the markup is parsed
 * into a tree, non-content elements are dropped, and only text nodes are read back (entities are decoded by
 * the parser). Links keep their text only; nothing from an attribute survives. Paragraph and list structure
 * becomes line breaks, and the result is bounded in length.
 */
export function htmlToText(html: string, maxLength = 20_000): string {
  if (html.trim() === '') return '';
  const $ = load(html, undefined, false);
  $(DROPPED).remove();
  $('br').replaceWith('\n');
  $('li').each((_, element) => {
    $(element).prepend('- ').append('\n');
  });
  $(BLOCKS).each((_, element) => {
    $(element).prepend('\n').append('\n');
  });

  const text = $.root()
    .text()
    .replace(/ /g, ' ')
    .replace(/[​-‍﻿]/g, '')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  return `${(lastBreak > maxLength * 0.8 ? cut.slice(0, lastBreak) : cut).trimEnd()}…`;
}
