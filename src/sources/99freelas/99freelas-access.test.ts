import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDetail, parseExclusiveCountdownSeconds } from './99freelas-parser.js';
import { toAccess } from './99freelas-source.js';

const LABEL = (countdown: string) => `Projeto Exclusivo. Ficará disponível para todos os profissionais em ${countdown}.`;

test('a clear countdown is converted to seconds', () => {
  assert.equal(parseExclusiveCountdownSeconds(LABEL('23h52m30s')), 23 * 3600 + 52 * 60 + 30);
  assert.equal(parseExclusiveCountdownSeconds(LABEL('45m')), 2700);
  assert.equal(parseExclusiveCountdownSeconds(LABEL('1d 2h')), 93_600);
  assert.equal(parseExclusiveCountdownSeconds(LABEL('59s')), 59);
});

for (const [name, label] of [
  ['no label', null],
  ['a label without the availability phrase', 'Projeto Exclusivo.'],
  ['a different sentence', 'Projeto Exclusivo. Termina em 23h52m30s.'],
  ['an unknown unit', LABEL('3 semanas')],
  ['a zero countdown', LABEL('0h0m0s')],
  ['a repeated unit', LABEL('1h 2h')],
  ['no digits', LABEL('algumas horas')],
  ['an absurdly long countdown', LABEL('99d')],
  ['trailing garbage after the countdown', 'Ficará disponível para todos os profissionais em 3h, talvez.'],
] as const) {
  test(`an uncertain countdown (${name}) is not turned into a number`, () => {
    assert.equal(parseExclusiveCountdownSeconds(label), null);
  });
}

test('publicAt is fetchedAt plus the countdown, and the raw label is preserved', () => {
  const access = toAccess(
    { exclusive: true, exclusiveLabel: LABEL('23h52m30s'), exclusiveCountdownSeconds: 85_950 },
    '2026-09-20T15:00:00.000Z',
  );
  assert.equal(access.kind, 'premium_only');
  assert.equal(access.publicAt, '2026-09-21T14:52:30.000Z');
  assert.equal(access.rawLabel, LABEL('23h52m30s'));
});

test('an exclusive project with an unreadable countdown is still restricted but never gets a fabricated publicAt', () => {
  const access = toAccess({ exclusive: true, exclusiveLabel: LABEL('algumas horas'), exclusiveCountdownSeconds: null }, '2026-09-20T15:00:00.000Z');
  assert.equal(access.kind, 'premium_only');
  assert.equal(access.publicAt, null);
  assert.equal(access.rawLabel, LABEL('algumas horas'));
});

test('a flag without any text keeps a generic raw label and no publicAt', () => {
  const access = toAccess({ exclusive: true, exclusiveLabel: null, exclusiveCountdownSeconds: null }, '2026-09-20T15:00:00.000Z');
  assert.deepEqual(access, { kind: 'premium_only', publicAt: null, rawLabel: 'Projeto exclusivo' });
});

test('a project without the exclusive flag is public', () => {
  assert.deepEqual(toAccess({ exclusive: false, exclusiveLabel: null, exclusiveCountdownSeconds: null }, '2026-09-20T15:00:00.000Z'), {
    kind: 'public',
    publicAt: null,
    rawLabel: null,
  });
});

function detailHtml(flag: string): string {
  return `<html><head><link rel="canonical" href="https://www.99freelas.com.br/project/exemplo-123"></head><body>
    <div class="box-project-view-principal"><div class="flags">${flag}</div>
      <h1 class="box-project-view-container-title"><span class="nomeProjeto">Exemplo</span></h1>
      <div class="project-description">Descricao</div></div>
    <div class="info-adicionais"><table><tr><th>Categoria:</th><td>Web</td></tr></table></div>
    <script>NineNineFreelas.pages.ProjectView.variables.idStatusProjeto = '2';</script></body></html>`;
}

test('parseDetail reads the exclusive flag text and its countdown from the page', () => {
  const html = detailHtml(`<img alt="Projeto exclusivo" title="${LABEL('23h52m30s')}">`);
  const detail = parseDetail(html);
  assert.equal(detail.exclusive, true);
  assert.equal(detail.exclusiveLabel, LABEL('23h52m30s'));
  assert.equal(detail.exclusiveCountdownSeconds, 85_950);
});

test('parseDetail on a page without the flag reports no exclusivity', () => {
  const detail = parseDetail(detailHtml(''));
  assert.equal(detail.exclusive, false);
  assert.equal(detail.exclusiveLabel, null);
  assert.equal(detail.exclusiveCountdownSeconds, null);
});
