import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HtmlFetcher } from './99freelas-client.js';
import { parseLastPage } from './99freelas-parser.js';
import { Freelas99Source } from './99freelas-source.js';

const LISTING = 'https://www.99freelas.com.br/projects?order=mais-recentes';

/** Minimal listing markup in the shape observed on the real site. */
function listingHtml(ids: string[], selected: number, last: number | null): string {
  const cards = ids
    .map(
      (id) => `<li class="with-flag result-item" data-id="${id}">
        <h1 class="title"><a href="/project/titulo-${id}?fs=t">Titulo ${id}</a></h1>
        <p class="item-text information">Categoria | Iniciante | Propostas: <b>0</b> | Interessados: <b>0</b></p>
        <div class="item-text description">Descricao ${id}</div></li>`,
    )
    .join('\n');
  const pagination =
    last === null
      ? ''
      : `<div class='pagination-component'>
          <span class='page-item selected' data-page="${selected}">${selected}</span>
          <span class='page-item go-to-last-page' data-page="${last}">Última</span></div>`;
  return `<html><body>${pagination}<ul>${cards}</ul>${pagination}</body></html>`;
}

function fetcher(responses: Record<string, string>): HtmlFetcher & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetchHtml: async (url: string) => {
      urls.push(url);
      const html = responses[url];
      if (html === undefined) throw new Error(`unexpected URL ${url}`);
      return html;
    },
  };
}

test('no cursor requests the newest page and offers the next cursor', async () => {
  const http = fetcher({ [LISTING]: listingHtml(['30', '29'], 1, 3) });
  const page = await new Freelas99Source(http).listRecent();
  assert.deepEqual(http.urls, [LISTING]);
  assert.deepEqual(page.items.map((item) => item.externalId), ['30', '29']);
  assert.equal(page.nextCursor, '2');
});

test('a cursor requests that page with the page parameter and keeps newest-first order', async () => {
  const http = fetcher({ [`${LISTING}&page=2`]: listingHtml(['20', '19', '21'], 2, 3) });
  const page = await new Freelas99Source(http).listRecent('2');
  assert.deepEqual(http.urls, [`${LISTING}&page=2`]);
  assert.deepEqual(page.items.map((item) => item.externalId), ['20', '19', '21']);
  assert.equal(page.nextCursor, '3');
});

test('the last page has no next cursor', async () => {
  const http = fetcher({ [`${LISTING}&page=3`]: listingHtml(['5'], 3, 3) });
  assert.equal((await new Freelas99Source(http).listRecent('3')).nextCursor, null);
});

test('a page without pagination markup is treated as the only page', async () => {
  const http = fetcher({ [LISTING]: listingHtml(['1'], 1, null) });
  assert.equal((await new Freelas99Source(http).listRecent()).nextCursor, null);
});

test('an empty page past the end is the end of the listing, not an error', async () => {
  const http = fetcher({ [`${LISTING}&page=99999`]: '<html><body>Nenhum projeto encontrado</body></html>' });
  assert.deepEqual(await new Freelas99Source(http).listRecent('99999'), { items: [], nextCursor: null });
});

test('an empty first page is an error (markup changed or access restricted)', async () => {
  const http = fetcher({ [LISTING]: '<html><body></body></html>' });
  await assert.rejects(new Freelas99Source(http).listRecent(), /No valid opportunities/);
});

test('invalid cursors are rejected before any request is made', async () => {
  const http = fetcher({});
  const source = new Freelas99Source(http);
  for (const bad of ['abc', '0', '-1', '2.5', '', '1e3', '../2']) {
    await assert.rejects(source.listRecent(bad), /Invalid 99freelas cursor/);
  }
  assert.deepEqual(http.urls, []);
});

test('parseLastPage reads the highest page from the control rendered twice', () => {
  assert.equal(parseLastPage(listingHtml(['1'], 1, 148)), 148);
  assert.equal(parseLastPage(listingHtml(['1'], 1, null)), null);
});
