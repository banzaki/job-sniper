# STATUS

Last updated: 2026-09-20 (SPEC 001 — 99Freelas listing and detail)

## Implemented

- `Freelas99Source` (`src/sources/99freelas/`) implements `OpportunitySource` with
  `sourceId = "99freelas"`:
  - `99freelas-client.ts` — transport: native `fetch`, explicit User-Agent and `Accept`,
    15 s timeout, 1.5 s minimum gap between requests, stops on HTTP 403/429,
    `cf-mitigated` header or CAPTCHA/challenge pages (`SourceBlockedError`, no retry).
  - `99freelas-parser.ts` — pure HTML → data (Cheerio), no network.
  - `99freelas-source.ts` — `listRecent()`, `fetchDetail()` and normalization to `Opportunity`.
- `src/index.ts` lists recent opportunities and prints up to 3 normalized details.
- Out of scope and **not started**: SQLite, dedup persistence, filters, Telegram, AI,
  dashboard, scheduler, second source, Playwright.

## RECON result (live, 2026-09-20)

- Listing `GET /projects?order=mais-recentes`: HTTP 200, `text/html;charset=UTF-8`,
  10 cards per page, plain server-rendered HTML (no JS needed, no challenge).
- The "captcha" strings in the HTML are login constants, not an access challenge.
- Card: `li.result-item[data-id]`, title/link in `h1.title a`, info line `p.information`,
  description in `div.description`.
- Detail pages: HTTP 200, canonical link present, data in `.info-adicionais` table.

### Fields available

| Field | Listing | Detail |
| --- | --- | --- |
| id, title, URL | yes | yes (canonical) |
| Description | full text | full text |
| Published | epoch ms in `cp-datetime` (exact) | relative ("hoje às 14:56") or `dd/mm/aaaa às HH:mm` |
| Category / subcategory | one label (actually the subcategory) | both, subcategory absent for "Outra Categoria" |
| Experience level | in info line | yes |
| Budget | no | `Orçamento` row |
| Proposals / interested | yes | yes (can differ; detail wins) |
| Skills | no | `.container-habilidades a.habilidade`, only when present |
| Status | no (filtered to open ones) | `idStatusProjeto` JS variable and, for some states, a `status-N` button |

## Parsing decisions

- `externalId` = trailing numeric id of `/project/<slug>-<id>`; the card's `data-id`
  must agree with it. The site ignores the slug (verified), so `/project/x-<id>` works
  when only the id is known. **A bare `/project/<id>` returns HTTP 200 with a
  "Não foi possível acessar a página" page (soft-404)**, so the parser validates
  content, not just status.
- Canonical URL: query string and fragment removed (`?fs=t` dropped); non-`/project/<slug>-<id>`
  links (e.g. `/project/new`, `/project/message/...`), other hosts and duplicates are ignored.
- `publishedAt`: listing epoch is exact and was cross-checked (17:56Z shown as 14:56 in
  Brasília). Detail: absolute dates parsed as UTC-3 (year ≥ 2019 only); relative dates give
  `null` and fall back to the listing value; never invented.
- Status (only with direct evidence, everything else `unknown`):
  - `2` → `open` ("Aguardando propostas", the site's own listing filter);
  - `15` → `open` ("Aguardando aprovação e propostas", same filter; a live page showed
    "Enviar proposta" and existing proposals) — **judgment call for Tech Lead review**;
  - `5` → `cancelled` (visible "Cancelado" button, class `status-5`).
- Budget: only `Aberto` observed → `kind: "open"`. Any other text → `kind: "unknown"` with the
  raw text kept in `sourceMetadata.budgetRaw`. Currency `BRL` is assumed from the site's `R$`.
- `sourceMetadata`: `statusCode`, `statusLabel`, `visibility`, `exclusive`, `budgetRaw`,
  `minimumValueRaw` (the page's "Valor Mínimo", meaning unconfirmed), `deadlineAt`,
  `publishedRaw`, `listingDivergence` (listing vs detail differences).

## Validations executed

| Check | Result |
| --- | --- |
| `npm run typecheck` | pass (exit 0) |
| `npm run build` | pass (exit 0) |
| `npm run dev` (live) | exit 0; 10 opportunities listed; 3 details normalized (all `open`) |
| Offline parser tests on saved HTML (not committed) | invalid/external/`/project/new` links rejected; duplicates removed; cancelled page → `cancelled`; soft-404 and empty listing → clear errors; invalid id rejected |
| Domain independence | no reference to the platform in `src/domain` or `opportunity-source.ts` |

## Known limitations

- No `closed` status code has been observed, so `closed` is never emitted.
- Only open-budget projects were seen; fixed/hourly/ranged budgets are not parsed.
- Only the first listing page (10 items) is read; no pagination.
- Many listed projects are "exclusive" (visible to all after ~24 h). They were readable
  without login, and this is recorded in `sourceMetadata.exclusive`.
- The site markup may change; the parser fails with a clear message when key data is missing.
- No automated test suite yet (checks were ad hoc scripts outside the repository).

## Blockers / risks

- No blockers. No HTTP 403/429 or CAPTCHA was encountered.
- Live RECON (7 requests) and two `npm run dev` runs (4 requests each) made about 15
  requests in total, sequential and spaced at least 1.5–2 s apart.

## Next authorized mission

**SPEC 002 — SQLite + deduplication + basic filter.** Not started.
