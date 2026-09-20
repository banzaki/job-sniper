# Job Sniper

## Mission

Job Sniper watches freelance and job platforms for new opportunities, filters
them against defined criteria, and notifies the owner quickly so they can
respond before the competition does.

The domain model is platform-independent. Each platform is an adapter behind
a common contract, so the core never depends on a specific website.

## Pipeline

1. **Collect** — list recent opportunities from a source (`OpportunitySource.listRecent`).
2. **Deduplicate** — skip opportunities already seen (SQLite).
3. **Enrich** — fetch details for new opportunities only (`OpportunitySource.fetchDetail`).
4. **Filter** — classify each opportunity against the interest profile.
5. **Notify** — send `shortlist` / `review` opportunities to Telegram, once each.

All five steps exist for a single source. The steps were built one SPEC at a time.

## Current flow

`npm run dev` runs one pass:

1. Re-evaluates stored opportunities whose filter result came from another rule version
   (offline, no source access).
2. Discovers opportunities page by page, newest first (see "Discovery" below), looking each
   one up in the local database by its stable key `sourceId:externalId`.
   Known ones only get `last_seen_at` updated; their details are **not** requested again.
3. Unseen ones (up to `MAX_DETAILS_PER_RUN`, newest first) get their details fetched, are
   normalized, filtered and stored. The rest wait for the next run.
5. Notifies: every stored opportunity with a chosen decision and `notified_at` empty is sent
   one at a time, including ones found in earlier runs. `notified_at` is set **only after
   Telegram confirms delivery**; on any failure it stays empty and the item is retried next run.

A collection failure (network, block) does not stop notifications for what is already stored.

## Discovery (pagination)

Each run starts at the newest listing page and only goes deeper while it still needs unseen
opportunities. One page is read at a time (sequential, with the usual delay); every summary is
compared with the database before any detail request. Pagination stops at the first of:

| Stop reason          | Meaning                                                                        |
| -------------------- | ------------------------------------------------------------------------------ |
| `target-new-reached` | `DISCOVERY_TARGET_NEW` unseen opportunities were collected                     |
| `max-pages-reached`  | `DISCOVERY_MAX_PAGES` pages were read                                          |
| `source-exhausted`   | the source has no next page, or returned an empty page                         |
| `repeated-page`      | a page brought no ID that this run had not already seen                        |
| `no-progress`        | the next cursor points back to a page already requested                        |
| `blocked`            | HTTP 403/429 or a CAPTCHA/challenge page: everything stops, no further request |
| `source-error`       | any other listing failure; what was already collected is still processed       |

Unseen opportunities are handled newest first. `DISCOVERY_TARGET_NEW` decides how deep to
look; `MAX_DETAILS_PER_RUN` caps how many details are actually requested. Unseen items beyond
that cap are reported as **deferred**: they are not stored, and the next run finds them again
only while they are still within the pages it scans (there is no persistent queue yet).

**Progressive backfill:** when page 1 is fully known, a run walks into older pages and picks up
opportunities that were never seen (for example ones published while the program was not running),
a few at a time. Later runs may therefore keep finding older opportunities; that is expected and is
not a deduplication failure. Notifications stay once-only: `notified_at` is untouched by discovery.

A source exposes pagination through one small contract: `listRecent(cursor?)` returns
`{ items, nextCursor }`, where the cursor is opaque to everything except the source (for 99Freelas it
is the page number). Nothing platform-specific reaches the domain.

## Filter (`basic-v2`)

Deterministic, no AI. Every decision carries concrete reasons, the matched terms and the rule
version. Signals are searched in title, description and skills:

- **Strong** (prove fit): HTML, CSS, JavaScript, TypeScript, landing page, front-end,
  responsividade, WordPress, front-end bug fixes, React (web), simple/institutional sites.
- **Weak** (generic words, never enough alone): API, integração, automação, bot, Telegram,
  sistema, site, web, bug.
- **Conflicting / advanced**: private AI, LLM, self-hosted, infrastructure, Kubernetes, DevOps,
  corporate architecture, native mobile, React Native, blockchain, telephony, voice agents.
  `React Native` is never counted as React web.

Decisions: `skip` for cancelled/closed, for a category clearly outside the profile with no strong
signal, and for work with no relation to the profile; `shortlist` for open work with a strong
signal and no conflict (or a directly relevant subcategory plus several weak signals);
`review` for everything doubtful (only weak signals, broad category without a strong skill,
unknown status, positive and conflicting signals together).

When the rule version changes, stored decisions are re-evaluated automatically (see below).

## Commands

| Command                  | Description                                                              |
| ------------------------ | ------------------------------------------------------------------------ |
| `npm run dev`            | One full pass: collect, dedup, filter, persist, notify                   |
| `npm run opportunities`  | List stored opportunities by shortlist / review / skip (read-only view)  |
| `npm run telegram:test`  | Send `🎯 Job Sniper online.` (printed only when `DRY_RUN=true`)          |
| `npm test`               | Offline tests (Node's built-in runner; no network, no Telegram)          |
| `npm run typecheck`      | Type-check without emitting files                                        |
| `npm run build`          | Compile TypeScript to `dist/`                                            |
| `npm run start`          | Run the compiled app (`node dist/index.js`)                              |

`npm run dev` and `npm run opportunities` first re-evaluate stored rows evaluated by an older
rule version (only the filter columns change; `first_seen_at` and `notified_at` are untouched)
and report how many were updated.

## Local database

SQLite through Node's built-in `node:sqlite` (no extra dependency; Node prints an
"experimental" warning). The file and its folder are created automatically and are never
deleted by the program. Database files are git-ignored.

## Environment variables

| Variable                    | Default                 | Purpose                                                    |
| --------------------------- | ----------------------- | ---------------------------------------------------------- |
| `DATABASE_PATH`             | `./data/job-sniper.db`  | SQLite file location                                       |
| `MAX_DETAILS_PER_RUN`       | `10`                    | Max detail requests per run (invalid value → `10`)         |
| `DISCOVERY_MAX_PAGES`       | `5`                     | Most listing pages read per run (positive integer, else the run fails) |
| `DISCOVERY_TARGET_NEW`      | `10`                    | Stop paginating after this many unseen opportunities (positive integer, else the run fails) |
| `DRY_RUN`                   | `true`                  | `true`: print messages, send nothing, mark nothing. Only an explicit `false` sends |
| `TELEGRAM_NOTIFY_DECISIONS` | `shortlist,review`      | Which decisions are notified                               |
| `TELEGRAM_BOT_TOKEN`        | —                       | Bot token, required only when `DRY_RUN=false`              |
| `TELEGRAM_CHAT_ID`          | —                       | Destination chat, required only when `DRY_RUN=false`       |

## Telegram setup (done locally by the owner)

1. In Telegram, talk to **@BotFather**, run `/newbot` and keep the token it gives you.
2. Open a chat with your new bot and send it any message (a bot cannot write first).
3. Find your chat id (for example by opening `getUpdates` for your bot in your own browser and
   reading `message.chat.id`).
4. `copy .env.example .env`, then fill `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`
   and set `DRY_RUN=false`. Never share the token in chat, commits or screenshots;
   `.env` is git-ignored.
5. `npm run telegram:test`, then `npm run dev`. Run `npm run dev` again: nothing already
   notified is sent twice.

The token is never printed. Error messages are scrubbed of it, and with `DRY_RUN=true`
the Telegram API is never called. If Telegram rejects the credentials or rate-limits the bot
(HTTP 401/403/404/429), sending stops for that run and the remaining items stay pending.

## Stack

- Node.js 24 and npm 11
- TypeScript (strict, ESM / NodeNext)
- Cheerio (HTML parsing), dotenv (configuration from `.env`), tsx (development runner)
- SQLite via `node:sqlite`, Telegram Bot API via native `fetch`

## Installation

```bash
npm install
```

## Current structure

```
src/
  index.ts                       Entrypoint: config, wiring, terminal report
  cli/opportunities.ts           npm run opportunities
  cli/telegram-test.ts           npm run telegram:test
  config.ts                      Environment settings with safe defaults
  domain/opportunity.ts          Platform-independent Opportunity model
  domain/filter-result.ts        FilterResult (shortlist | review | skip)
  profile/                       InterestProfile type and Don Bruno's profile
  filter/opportunity-filter.ts   Deterministic, explainable filter (basic-v2)
  storage/opportunity-store.ts   Generic SQLite persistence
  pipeline/run-pipeline.ts       list -> dedup -> details -> filter -> persist
  pipeline/reevaluate.ts         Re-runs the filter on stored rows of older rule versions
  notify/                        Notifier interface, Telegram client, message format, pending sender
  sources/opportunity-source.ts  OpportunitySource contract (paged: listRecent(cursor) -> items + nextCursor)
  **/*.test.ts                   Offline tests next to the code they cover (npm test)
  sources/source-errors.ts       Blocked / unusable-response errors
  sources/99freelas/             First adapter: client (transport), parser (HTML), source
.env.example                     Configuration template (no secrets)
STATUS.md                        Current project state
CLAUDE.md                        Working rules for the implementation agent
```

## Scope notice

V1 implements **one** source first and proves the full pipeline with it before any
other source is added.
