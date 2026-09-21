import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeHtml, excerpt, splitPlainText, visibleLength } from './html.js';

test('visibleLength counts what Telegram counts: tags are free and entities are one character', () => {
  assert.equal(visibleLength('<b>Olá</b>'), 3);
  assert.equal(visibleLength('a &amp; b &lt;c&gt; &quot;d&quot;'), 'a _ b _c_ _d_'.length);
  assert.equal(visibleLength(escapeHtml('<script>&"')), 10);
  assert.equal(visibleLength('<a href="https://x.test/?a=1&amp;b=2">link</a>'), 4);
});

test('short text is returned as one piece, empty text as none', () => {
  assert.deepEqual(splitPlainText('Olá, mundo.', 100), ['Olá, mundo.']);
  assert.deepEqual(splitPlainText('   \n ', 100), []);
});

test('paragraphs stay whole when they fit, and pieces respect the limit', () => {
  const paragraphs = Array.from({ length: 6 }, (_, i) => `Parágrafo ${i} ${'x'.repeat(80)}.`);
  const pieces = splitPlainText(paragraphs.join('\n\n'), 200);
  assert.ok(pieces.every((piece) => piece.length <= 200));
  assert.ok(pieces.length >= 3);
  for (const paragraph of paragraphs) assert.ok(pieces.some((piece) => piece.includes(paragraph)), 'a paragraph is never cut in the middle');
});

test('a long paragraph is cut at sentence boundaries, not in the middle of a sentence', () => {
  const sentences = Array.from({ length: 12 }, (_, i) => `Esta é a frase número ${i} do texto com acentuação e ação.`);
  const pieces = splitPlainText(sentences.join(' '), 150);
  assert.ok(pieces.every((piece) => piece.length <= 150));
  for (const piece of pieces) assert.match(piece, /\.$/, 'every piece ends where a sentence ends');
  assert.equal(pieces.join(' '), sentences.join(' '), 'nothing is dropped or altered');
});

test('a sentence longer than the limit falls back to words, and no word is lost', () => {
  const sentence = Array.from({ length: 60 }, (_, i) => `palavra${i}`).join(' ');
  const pieces = splitPlainText(sentence, 100);
  assert.ok(pieces.every((piece) => piece.length <= 100));
  assert.equal(pieces.join(' '), sentence);
});

test('a single word longer than the limit is split by characters, never inside an emoji', () => {
  const word = '😀'.repeat(50);
  const pieces = splitPlainText(word, 21);
  assert.ok(pieces.every((piece) => piece.length <= 21));
  assert.equal(pieces.join(''), word);
  assert.ok(pieces.every((piece) => !/[\uD800-\uDBFF]$/.test(piece) && !/^[\uDC00-\uDFFF]/.test(piece)), 'no surrogate pair is broken');
});

test('splitting never uses an ellipsis to hide dropped text', () => {
  const text = Array.from({ length: 200 }, (_, i) => `Frase ${i} completa.`).join(' ');
  const pieces = splitPlainText(text, 300);
  assert.ok(pieces.every((piece) => !piece.includes('…')));
  assert.equal(pieces.join(' '), text);
});

test('excerpt prefers a sentence boundary, then a word, and reports truncation', () => {
  const text = 'Primeira frase completa aqui. Segunda frase que continua por bastante tempo ainda.';
  assert.deepEqual(excerpt(text, 200), { text, truncated: false });
  assert.deepEqual(excerpt(text, 40), { text: 'Primeira frase completa aqui.', truncated: true });
  const noSentence = excerpt('palavra '.repeat(30), 50);
  assert.ok(noSentence.truncated && noSentence.text.endsWith('…') && noSentence.text.length <= 51);
});
