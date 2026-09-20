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
3. **Enrich** — fetch details for new opportunities (`OpportunitySource.fetchDetail`).
4. **Filter** — keep only opportunities matching the configured criteria.
5. **Notify** — send matches to Telegram (with a dry-run mode).

> The steps are built one SPEC at a time. Only steps 1 and 3 exist so far, for a single
> source, and they end in the terminal (no database, filter or notifications yet).

## Stack

- Node.js 24 and npm 11
- TypeScript (strict, ESM / NodeNext)
- Cheerio (HTML parsing)
- dotenv (configuration from `.env`)
- tsx (development runner)

Planned but **not installed yet**: SQLite and a Telegram client.

## Installation

```bash
npm install
cp .env.example .env   # then fill in your own values; never commit .env
```

## Commands

| Command             | Description                                      |
| ------------------- | ------------------------------------------------ |
| `npm run dev`       | Run `src/index.ts` with tsx                      |
| `npm run typecheck` | Type-check without emitting files                |
| `npm run build`     | Compile TypeScript to `dist/`                    |
| `npm run start`     | Run the compiled app (`node dist/index.js`)      |

## Current structure

```
src/
  index.ts                       Lists recent opportunities and prints up to 3 details
  domain/opportunity.ts          Platform-independent Opportunity model
  sources/opportunity-source.ts  OpportunitySource contract
  sources/source-errors.ts       Blocked / unusable-response errors
  sources/99freelas/             First adapter: client (transport), parser (HTML), source
.env.example                   Configuration template (no secrets)
STATUS.md                      Current project state
CLAUDE.md                      Working rules for the implementation agent
```

## Scope notice

V1 will implement **one** source first and prove the full pipeline with it
before any other source is added.
