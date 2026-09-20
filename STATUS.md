# STATUS

Last updated: 2026-09-20 (SPEC 003.1 — adaptive pagination, APPROVED by the Tech Lead and committed)

## Implemented

- **Filter `basic-v2`** (`src/filter/opportunity-filter.ts`, `src/profile/`): strong / weak /
  conflicting signals. Fixes the `basic-v1` false positive ("Implantação de IA privada para
  empresa" was shortlisted only because of the word "API"). It is now `review`.
- **Re-evaluation** (`src/pipeline/reevaluate.ts`): stored rows evaluated by another rule version
  are re-filtered offline from their stored payload. Only decision, reasons, keywords, time and
  version change; `first_seen_at`, `last_seen_at` and `notified_at` are untouched. Runs at the
  start of `npm run dev` and `npm run opportunities`, and reports how many rows changed.
- **`npm run opportunities`**: stored opportunities grouped by shortlist / review / skip with
  reasons, category, status, URL and notification state (`pending`, `sent <time>`, `not eligible`).
  Never prints `payload_json`.
- **Telegram** (`src/notify/`), separate from the adapter and the database: `Notifier` interface,
  `TelegramNotifier` (native `fetch`, 15 s timeout, ~1.1 s between messages, HTTP status **and**
  `ok:true` validated, HTML parse mode with escaping, token scrubbed from every error),
  `ConsoleNotifier` for dry-run, message formatter, and `notifyPending`.
- **`npm run telegram:test`**: sends `🎯 Job Sniper online.`; with `DRY_RUN=true` it only prints.
- **Config**: `DRY_RUN` (default `true`; only an explicit `false` sends), `TELEGRAM_NOTIFY_DECISIONS`
  (default `shortlist,review`), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (required only when
  `DRY_RUN=false`; validated before any request is made). `.env.example` updated.
- Not started: AI/LLM, dashboard, scheduler, application/proposal, second source, Playwright.

## SPEC 003.1 — Adaptive pagination and discovery depth (approved)

**RECON (live, 6 sequential requests):**
- Page N is `/projects?order=mais-recentes&page=N`. Page 2 returns IDs completely different from page 1.
  The site had 148 pages at the time (changes constantly). Page 148 returned 6 items and no "next" page.
- `page=99999` → HTTP 200 with zero items and a "nenhum projeto" message (the end, not an error).
- `page=0` → HTTP 200 with **page 1 content again** (repeated content, which the pipeline must detect).
- `page=abc` → HTTP 404 (already handled by the client as an unexpected response).
- Pages shift between requests (new items push older ones down), so partial overlap is normal.

**Design:** one small generic contract change. `OpportunitySource.listRecent(cursor?)` returns
`{ items, nextCursor }`; the cursor is an opaque string owned by the source (99Freelas: the page number).
Nothing platform-specific reaches `Opportunity`. The 99Freelas adapter builds `&page=N`, validates the
cursor (`^[1-9]\d{0,5}$`), derives "has next page" from the pagination control, and treats an empty page
past page 1 as the end. The pipeline scans page by page, newest first:
known/unseen split against SQLite per page → collect unseen → go deeper only while below the target.

**Stop reasons** (`pagination stop` line of the run summary): `target-new-reached`, `max-pages-reached`,
`source-exhausted` (no next page or empty page), `repeated-page` (a page with no ID new to this run),
`no-progress` (cursor points back to a requested page), `blocked` (403/429/challenge: no further request
of any kind, known items still marked as seen), `source-error` (collected items are still processed).

**Configuration:** `DISCOVERY_MAX_PAGES=5`, `DISCOVERY_TARGET_NEW=10` (both positive integers; an invalid
value fails the run with a `ConfigError` naming the variable). `MAX_DETAILS_PER_RUN` (existing) still caps
detail requests; unseen items beyond it are "deferred" (not stored, found again next run).

**Offline tests:** `npm test` (Node's built-in runner, no new dependency): 40 tests, all pass. Covers page 1
fully known → page 2, target before page limit, empty page, repeated page, partial overlap, cursor without
progress, page limit with nothing new, newest-first order and detail limit, deferred items, block on a deeper
page (no detail requests), non-block error on a deeper page, notification deduplication and failed-delivery
retry, adapter URL/cursor/empty-page/last-page behavior, and configuration validation. A mutation check
(deduplication deliberately broken) made 5 tests fail, then it was reverted.

**Live run (`npm run dev`, mode LIVE, defaults):**

| Counter | Value |
| --- | --- |
| pages scanned | 3 |
| summaries discovered | 30 |
| already known | 16 |
| unseen collected | 14 |
| details requested | 10 |
| deferred (limit) | 4 |
| pagination stop | `target-new-reached` |
| persisted | 10 (shortlist 2, review 1, skip 7) |
| failures | 0 |
| HTTP requests | 13 (3 listing pages + 10 details) |
| notifications | pending 3, sent 3, failures 0 |
| database rows | 17 → 27, all distinct |

Details avoided: 16 (every known summary). The deferred 4 are the oldest of the 14 unseen (newest first
was preserved). Database afterwards: 7 rows with `notified_at` in two batches (4 from the earlier live
validation, unchanged, and 3 from this run), 0 pending, 0 rows notified twice. Page 1 already held
new items (published after the previous validation), so scanning more than one page was needed only
because the target of 10 had not been reached; page 3 was the first to reach it.

## Filter rules `basic-v2`, in order

Signals are searched in title, description and skills (case/accent/punctuation-insensitive, whole words).

1. status `cancelled` or `closed` → **skip**.
2. At least one **strong** signal:
   any conflicting signal, a category outside the profile, or status not `open` → **review**;
   otherwise → **shortlist**.
3. No strong signal:
   - category outside the profile → **skip**;
   - directly relevant category: ≥ 2 weak signals, no conflict, status open → **shortlist**;
     otherwise → **review**;
   - any weak or conflicting signal, or a broad category → **review**;
   - missing or non-specific category ("Outra Categoria") → **review**;
   - anything else (specific category on no list, no signals) → **skip**.

A weak signal alone never produces a shortlist.

- **Strong**: HTML, CSS, JavaScript, TypeScript, landing page, front-end, responsividade, WordPress,
  front-end bug fixes, React (web; matches inside "React Native" are ignored), simple/institutional
  site or page.
- **Weak**: API, integração, automação, bot, Telegram, sistema, site, web, desenvolvimento web, bug.
- **Conflicting**: IA privada, LLM, self-hosted, infraestrutura, Kubernetes, DevOps, arquitetura
  corporativa, native mobile (kotlin, swiftui…), React Native / Flutter, blockchain, telefonia,
  agente de voz.
- **Directly relevant categories**: Desenvolvimento Web, Desenvolvimento Front-end,
  Integrações e Automações. **Broad**: Web, Mobile & Software.
  **Outside the profile**: Administração & Contabilidade, Advogados & Leis, Atendimento ao
  Consumidor, Design & Criação, Educação & Consultoria, Escrita, Fotografia & AudioVisual,
  Suporte Administrativo, Tradução, Vendas & Marketing.

## Evidence (2026-09-20, no secrets, `DRY_RUN=true`)

- **Re-evaluation**: `npm run opportunities` → `re-evaluated 12 stored opportunities (basic-v1 x12 -> basic-v2)`,
  no source access. Result on those 12: shortlist 0 / review 3 / skip 9.
  The AI-private job (`785758`) is now `review`: "weak signals: API, integração; conflicting or
  advanced scope: IA privada, LLM, self-hosted, infraestrutura". The mobile app job (`785729`,
  previously shortlisted by category alone) is also `review`.
- **Pipeline dry-run** (`npm run dev`): listed 10, already known 7, new 3, details requested 3,
  persisted 3 (all skip), failures 0, HTTP requests 4 (source only); notifications pending=3,
  rendered=3, none sent, none marked. Re-evaluation in that run: 0 (already done).
- **Telegram test dry-run**: printed `🎯 Job Sniper online.`, "Telegram was NOT called".
- **Database afterwards**: 15 rows, 15 distinct keys, all `basic-v2`, `notified_at` set on **0** rows,
  earliest `first_seen_at` unchanged.
- **Offline checks** (fake `fetch`, fake notifiers, file DB; scripts kept outside the repo): 57 passed.
  They cover the filter on the 12 real payloads and 20+ synthetic cases; escaping, length and
  no-description guarantees of the message; Telegram client (success, `ok:false` on HTTP 200, 401/429
  fatal, 400 non-fatal, non-JSON body, network error containing the token, timeout, oversize);
  re-evaluation keeping `first_seen_at`/`notified_at`; dry-run never marking or calling the network;
  live mode marking only after confirmed delivery, failed items staying `NULL` and being retried,
  already-notified items never re-sent, rows from earlier runs being notified, fatal errors aborting the rest;
  config defaults and credential validation.

## Notification rules (verified)

- Only `shortlist` and `review` (configurable), only when `notified_at IS NULL`, one at a time, oldest first.
- Marked notified **only after** Telegram answers HTTP 2xx with `ok:true`. Failure, timeout or
  `DRY_RUN=true` leave `notified_at` empty.
- Fatal statuses (401/403/404/429) stop the rest of that run; everything unsent stays pending.

## Live validation (Telegram) — PASSED

Performed by Don Bruno with real credentials in the git-ignored `.env`, and reviewed by the Tech Lead
(Tony Diablo). The figures below were reported to the implementer; the implementer did not run these
two executions and did not see the messages. The four Telegram messages were visually confirmed.

| Counter | Run 1 (`DRY_RUN=false`, mode LIVE) | Run 2 |
| --- | --- | --- |
| listed | 10 | 10 |
| already known | 8 | 10 |
| new | 2 | 0 |
| details requested | 2 | 0 |
| persisted | 2 (1 review, 1 skip) | 0 |
| pending notifications | 4 | 0 |
| sent | 4 | 0 |
| notification failures | 0 | 0 |

This proves end to end: delivery, persistence, deduplication, and no duplicate Telegram notifications.
Run 1 sent 4 messages although only 2 items were new, which also confirms that stored opportunities
from earlier runs are notified (not only those discovered in the current run).

## Technical debt (accepted by the Tech Lead, non-blocking)

1. **Deferred items are not persisted.** Unseen summaries beyond `MAX_DETAILS_PER_RUN` are only reported
   as "deferred". They could leave the configured discovery window (`DISCOVERY_MAX_PAGES` newest pages)
   before the next run and never be detailed. A **persistent discovery queue** should be considered
   before any scheduled, autonomous operation.
2. **Configuration is loaded globally.** An invalid `DISCOVERY_*` value also breaks commands that do not
   discover anything (`npm run opportunities`, `npm run telegram:test`). Decouple it before or during
   the scheduler milestone.
3. **Deep historical backfill is bounded by design**: at most `DISCOVERY_MAX_PAGES` pages per run,
   sequential and rate limited. There is no unbounded crawling.

## Known limitations

- Delivery is at-least-once: if Telegram delivers but the reply is lost (timeout) or writing
  `notified_at` fails, the item is sent again next run.
- The message shows counts (proposals, interested) as of the first detail fetch, not live values
  (the mobile app job showed 12/17 in the dry-run message versus 3/6 when first fetched).
- No cap on messages per run: a large backlog would be sent at ~1 per second.
- Term matching has no semantics or negation. "sistema", "site" and "web" are common words, so
  `review` can be noisy; that is the intended direction for doubt.
- Changing the profile or rules requires bumping `FILTER_RULE_VERSION`, otherwise stored rows are not
  re-evaluated.
- Discovery reads at most `DISCOVERY_MAX_PAGES` (default 5) pages per run, so older opportunities are
  reached progressively (backfill) and deep history is never guaranteed. A large value costs one
  request per page plus one per detail, spaced ~1.5 s apart.
- Deferred items are not stored: they are found again next run only while they remain within the pages
  scanned; if newer items push them out of range they can be missed.
- Pages shift while a run is in progress; overlap is deduplicated, but an item moving from a not yet
  scanned page to an already scanned one can be missed until a later run.
- No `closed` status code observed; only "Aberto" budgets interpreted; `node:sqlite` is experimental.
- Offline tests cover discovery, adapter pagination and configuration; the filter, Telegram client and
  message formatting were verified by ad hoc scripts (not in the repository).
- Message labels are in English (project rule for UI text) although the SPEC sketched Portuguese ones.

## Blockers / risks

- No blockers. SPEC 003 is closed (commit `b0495bc`); SPEC 003.1 is approved and committed
  (`feat: add adaptive opportunity discovery`).
- `data/job-sniper.db` holds real data from the live site (git-ignored).
- **Secret hygiene:** at closing time the working copy of `.env.example` (a tracked file) contained
  a bot token-like value. It was never committed (history and HEAD checked); the SPEC 003 commit
  contains a sanitized `.env.example`. The token must live only in `.env`. Because it was written
  to a tracked file and appeared in a tool result of this session, consider revoking and
  regenerating it with @BotFather (`/revoke`) and updating `.env`.

## Next authorized mission

**SPEC 004 — AI + analysis + assisted proposal.** Not started; awaiting authorization.
