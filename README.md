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
2. Lists the source's recent opportunities (one HTTP request).
3. Looks each one up in the local database by its stable key `sourceId:externalId`.
   Known ones only get `last_seen_at` updated; their details are **not** requested again.
4. New ones (up to `MAX_DETAILS_PER_RUN`) get their details fetched, are normalized,
   filtered and stored. The rest wait for the next run.
5. Notifies: every stored opportunity with a chosen decision and `notified_at` empty is sent
   one at a time, including ones found in earlier runs. `notified_at` is set **only after
   Telegram confirms delivery**; on any failure it stays empty and the item is retried next run.

A collection failure (network, block) does not stop notifications for what is already stored.

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
  sources/opportunity-source.ts  OpportunitySource contract
  sources/source-errors.ts       Blocked / unusable-response errors
  sources/99freelas/             First adapter: client (transport), parser (HTML), source
.env.example                     Configuration template (no secrets)
STATUS.md                        Current project state
CLAUDE.md                        Working rules for the implementation agent
```

## Scope notice

V1 implements **one** source first and proves the full pipeline with it before any
other source is added.
