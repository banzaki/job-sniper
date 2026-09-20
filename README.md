# Job Sniper

## Mission

Job Sniper watches freelance and job platforms for new opportunities, filters
them against defined criteria, and notifies the owner quickly so they can
respond before the competition does.

The domain model is platform-independent. Each platform is an adapter behind
a common contract, so the core never depends on a specific website.

## Planned pipeline

1. **Collect** — list recent opportunities from a source (`OpportunitySource.listRecent`).
2. **Deduplicate** — skip opportunities already seen (SQLite).
3. **Enrich** — fetch details for new opportunities only (`OpportunitySource.fetchDetail`).
4. **Filter** — keep only opportunities matching the interest profile.
5. **Notify** — send matches to Telegram (with a dry-run mode).

> The steps are built one SPEC at a time. Steps 1 to 4 exist for a single source and end
> in the terminal. Step 5 (Telegram) is not implemented yet.

## Current flow

`npm run dev` runs one pass:

1. Lists the source's recent opportunities (one HTTP request).
2. Looks each one up in the local database by its stable key `sourceId:externalId`.
3. Known ones only get `last_seen_at` updated; their details are **not** requested again.
4. New ones (up to `MAX_DETAILS_PER_RUN`) get their details fetched, are normalized,
   evaluated by the filter and stored. The rest wait for the next run.
5. Prints counters, plus the `shortlist` and `review` items with the reasons for each decision.

The filter is deterministic (no AI): every decision carries concrete reasons, the matched
terms and a rule version. `cancelled`/`closed` opportunities are skipped; doubt favors `review`.

## Local database

SQLite through Node's built-in `node:sqlite` (no extra dependency; Node prints an
"experimental" warning). The file and its folder are created automatically and are never
deleted by the program. Database files are git-ignored.

## Environment variables

| Variable              | Default                 | Purpose                                            |
| --------------------- | ----------------------- | -------------------------------------------------- |
| `DATABASE_PATH`       | `./data/job-sniper.db`  | SQLite file location                               |
| `MAX_DETAILS_PER_RUN` | `10`                    | Max detail requests per run (invalid value → `10`) |

`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` and `DRY_RUN` exist in `.env.example` for a later
SPEC and are not read yet.

## Stack

- Node.js 24 and npm 11
- TypeScript (strict, ESM / NodeNext)
- Cheerio (HTML parsing), dotenv (configuration from `.env`), tsx (development runner)
- SQLite via `node:sqlite`

Planned but **not installed yet**: a Telegram client.

## Installation

```bash
npm install
cp .env.example .env   # optional; then fill in your own values, never commit .env
```

## Commands

| Command             | Description                                      |
| ------------------- | ------------------------------------------------ |
| `npm run dev`       | Run one pipeline pass with tsx                   |
| `npm run typecheck` | Type-check without emitting files                |
| `npm run build`     | Compile TypeScript to `dist/`                    |
| `npm run start`     | Run the compiled app (`node dist/index.js`)      |

## Current structure

```
src/
  index.ts                       Entrypoint: config, wiring, terminal report
  config.ts                      DATABASE_PATH / MAX_DETAILS_PER_RUN with safe defaults
  domain/opportunity.ts          Platform-independent Opportunity model
  domain/filter-result.ts        FilterResult (shortlist | review | skip)
  profile/                       InterestProfile type and Don Bruno's profile
  filter/opportunity-filter.ts   Deterministic, explainable filter
  storage/opportunity-store.ts   Generic SQLite persistence
  pipeline/run-pipeline.ts       list -> dedup -> details -> filter -> persist
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
