# STATUS

Last updated: 2026-09-20 (SPEC 002 — SQLite, deduplication, filter)

## Implemented

- **Hotfix, status 15** (`99freelas-source.ts`, `99freelas-parser.ts`): code 15 alone is no
  longer `open`. It is `open` only with an independent real "Enviar proposta" action on the
  page (`a[href^="/project/bid/"]`), otherwise `unknown`. Codes 2 (open) and 5 (cancelled)
  are unchanged; any other code is `unknown`. `sourceMetadata` now records `statusCode`
  (raw code), `statusLabel` (raw status button text, if any), `statusEvidence`,
  `statusNormalized` and `canSubmitProposal`.
- **SQLite** (`src/storage/opportunity-store.ts`): generic `OpportunityStore` on `node:sqlite`,
  parameterized statements only, unique `(source_id, external_id)`, schema version in
  `PRAGMA user_version`, folder and file created automatically, invalid stored JSON raises
  `StoreDataError` with the id and column.
- **Config** (`src/config.ts`): `DATABASE_PATH` (default `./data/job-sniper.db`) and
  `MAX_DETAILS_PER_RUN` (default `10`; invalid values warn and fall back).
- **Profile** (`src/profile/`): platform-independent `InterestProfile` and Don Bruno's profile.
- **Filter** (`src/filter/opportunity-filter.ts`): deterministic, no AI, rule version `basic-v1`.
- **Pipeline** (`src/pipeline/run-pipeline.ts`) and `src/index.ts`: list → known? → details for
  new only → normalize → filter → persist, with a counter report.
- Not started: Telegram, AI, dashboard, scheduler, second source, pagination, Playwright.

## Database schema (version 1)

```sql
CREATE TABLE opportunities (
  id                    TEXT PRIMARY KEY,            -- "sourceId:externalId"
  source_id             TEXT NOT NULL,
  external_id           TEXT NOT NULL,
  title                 TEXT NOT NULL,
  url                   TEXT NOT NULL,
  status                TEXT NOT NULL,
  payload_json          TEXT NOT NULL,               -- full normalized Opportunity
  first_seen_at         TEXT NOT NULL,
  last_seen_at          TEXT NOT NULL,
  filter_decision       TEXT NOT NULL CHECK (filter_decision IN ('shortlist','review','skip')),
  filter_reasons_json   TEXT NOT NULL,
  filter_keywords_json  TEXT NOT NULL,
  filter_evaluated_at   TEXT NOT NULL,
  filter_rule_version   TEXT NOT NULL,
  notified_at           TEXT,                        -- NULL until a later SPEC notifies
  UNIQUE (source_id, external_id)
);
```

## Filter rules (`basic-v1`), in order

1. status `cancelled` or `closed` → **skip**.
2. Relevant category (or subcategory) **or** at least one interest term:
   status `open` → **shortlist**; status `unknown` → **review**.
3. No positive signal:
   a specific category that is not on the interest list → **skip**;
   category missing or non-specific ("Outra Categoria") → **review**.

Matching is case-, accent- and punctuation-insensitive with whole-word boundaries
("bot" does not match "robotica"; "&" reads as "e"). Text searched: title, description, skills.
Terms: HTML, CSS, JavaScript, TypeScript, React, front-end, landing page, responsividade,
WordPress, correção de bugs (also "bug"/"bugs"), API, bot, Telegram, automação,
pequenas integrações, desenvolvimento web (also "website", "criação de site", …).
Relevant categories: Web, Mobile & Software; Desenvolvimento Web; Desenvolvimento Front-end;
Integrações e Automações. Broad words ("site", "integração") are deliberately not used alone.

## Evidence: two real runs (2026-09-20)

| Counter | Run 1 | Run 2 |
| --- | --- | --- |
| listed | 10 | 10 |
| already known | 0 | 10 |
| new | 10 | 0 |
| deferred (limit) | 0 | 0 |
| details requested | 10 | **0** |
| persisted | 10 | 0 |
| shortlist / review / skip | 1 / 1 / 8 | (none new) |
| failures | 0 | 0 |
| HTTP requests | 11 | **1** (listing only) |
| database rows | 10 | 10 |

Direct database check afterwards: 10 rows, 10 distinct `(source_id, external_id)`, 10 distinct
ids, `last_seen_at > first_seen_at` on all 10 (updated by run 2), `notified_at` NULL on all.
The default limit (10) covered the whole page, so no queue remained; the "deferred" counter
(new items left for a later run) is what separates a waiting item from a duplicate.

## Validations executed

| Check | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run build` | pass |
| `npm run dev` × 2 (live) | pass; see table above |
| Offline checks (fake source, file DB; scripts kept outside the repo) | 28 passed: status hotfix (2/5/15 with and without action, unknown code), filter rules and word boundaries, dedup within a listing, limit and deferral, known items never re-fetched, unique constraint, failure isolation, blocked run stops immediately keeping earlier work, corrupt JSON, reopening keeps data, hostile title stored as data, config defaults |
| Domain independence | no platform name in `src/domain`, `src/storage`, `src/filter`, `src/profile`, `src/pipeline` |

## Known limitations

- **Parent category alone shortlists.** Per the SPEC, "Web, Mobile & Software" is relevant on
  its own, so a mobile app project (subcategory "Desenvolvimento Mobile") was shortlisted with
  no interest term. Tightening this (e.g. review instead of shortlist for category-only matches)
  is a product decision for later.
- Term matching has no semantics: "React Native" matches "React"; negations are not understood.
- A new item whose detail fails is not stored and is retried as new on the next run.
- Only the first listing page is read; a project that leaves the first page before a run
  is never seen. No pagination.
- No `closed` status code has been observed, so `closed` is never emitted.
- Budgets other than "Aberto" are not interpreted.
- `node:sqlite` is experimental in Node 24 and prints a warning on every run.
- No automated test suite in the repository yet.

## Blockers / risks

- No blockers. No HTTP 403/429 or CAPTCHA encountered.
- `data/job-sniper.db` now exists locally (git-ignored). It is real data from the live site.

## Next authorized mission

**SPEC 003 — Telegram + end-to-end pipeline.** Not started.
