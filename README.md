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
5. **Analyze (optional)** — AI compatibility analysis, price range and proposal draft, in batches of up to 20.
6. **Notify** — send opportunities to Telegram, once each; AI results enrich the message.

All steps exist for a single source. The steps were built one SPEC at a time.

## Current flow

`npm run dev` runs one pass:

1. Re-evaluates stored opportunities whose filter result came from another rule version
   (offline, no source access).
2. Discovers opportunities page by page, newest first (see "Discovery" below), looking each
   one up in the local database by its stable key `sourceId:externalId`.
   Known ones only get `last_seen_at` updated; their details are **not** requested again.
3. Unseen ones (up to `MAX_DETAILS_PER_RUN`, newest first) get their details fetched, are
   normalized, filtered and stored. The rest wait for the next run.
4. If `AI_ENABLED=true` (and `DRY_RUN=false`), analyzes pending open opportunities with the AI
   provider, newest first, up to `AI_MAX_ANALYSES_PER_RUN` (see "AI analysis" below).
5. Notifies: every stored opportunity with a chosen decision and `notified_at` empty is sent
   one at a time, including ones found in earlier runs (as an AI-enriched message when an analysis
   exists). `notified_at` is set **only after Telegram confirms delivery**; on any failure it stays
   empty and the item is retried next run.

A collection or AI failure (network, block, quota) does not stop notifications for what is already stored.

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

## AI analysis (optional, Gemini free tier)

Off by default (`AI_ENABLED=false`); with it off, everything else works exactly as before.
When on, after discovery the program analyzes **pending open opportunities, newest first, up to
`AI_MAX_ANALYSES_PER_RUN` (at most 20)**, one request at a time (~6.5 s apart to stay under free-tier
rate limits). Cancelled, closed and unknown-status opportunities are never analyzed. Stored open ones
that lack a result for the current **analysis version** (`ai-v1`) are picked up too (backfill); an
opportunity is never analyzed twice for the same version unless forced.

Per opportunity the model returns, and the program validates locally: score 0-100 (technical fit only),
confidence, recommendation (`apply`/`review`/`skip`), fit explanation, matched and missing skills,
risks, questions for the client, effort range, complexity, a BRL price range with rationale, and a
proposal draft in Brazilian Portuguese. Invalid, incomplete or out-of-range answers are **never stored
as a success**. The AI result is stored **next to** the deterministic `basic-v2` decision, never over it.

- **Skill verification.** The candidate profile (`src/profile/bruno-candidate.ts`) separates **confirmed**
  (verified by the owner), **unverified** (an interest; competence not verified), **learning** and
  **unavailable** skills, plus the owner's declared context (currently: a beginner working with guidance and AI,
  no complete landing page published yet). Nothing is confirmed until the owner says so. The model lists every
  **essential** skill for the delivery; an `apply` stands only if there is at least one and **all** of them are
  confirmed (one confirmed skill never compensates for another essential one that is unverified, being learned
  or outside the profile). Otherwise it becomes `review`, confidence is capped at `medium`, and the uncertainty is
  spelled out. Proposals may not assert competence. The score is a technical-fit rating, not a probability.
- **Analysis version.** Results are stored per opportunity and version = prompt version + a fingerprint of the
  profile (`ai-v2+p…`). Changing the profile in a relevant way makes everything eligible again; older results
  stay as history and their proposal drafts are marked `discarded`.
- **Truthfulness.** The prompt and a local guard use the candidate profile and any recorded experience (currently none). The prompt forbids inventing
  experience, clients, projects, years or certifications; matched skills outside the profile are moved
  to "missing"; and a local guard rejects proposals that claim mastery, certifications, years or past
  clients, mention unavailable skills, or contain links, e-mail, phone numbers or off-platform payment.
- **Prompt injection.** Opportunity text travels as one JSON data block, is declared untrusted, and cannot
  change the instructions. Suspicious content (external links, off-platform requests, credential or
  payment requests) is turned into listed risks. Output must be JSON and is validated field by field.
- **Free tier only.** One model (`AI_MODEL`), no grounding or tools, **no fallback to another model or
  provider**. The key travels in a request header and is scrubbed from every error and never stored.
  HTTP 429 (quota) stops the batch: completed analyses stay saved, the rest stay pending. Timeouts,
  network errors and 5xx get exactly one retry; three outages in a row end the batch. A bad key or model
  stops the batch without blaming any opportunity. Failed opportunities are recorded (with a trimmed,
  secret-free message) and simply retried by the next run.
- **Restricted access.** A source can mark an opportunity as `premium_only` (99Freelas: "Projeto
  Exclusivo", which opens to everyone after a countdown). The candidate's 99Freelas account is recorded
  as **free**, so a compatible restricted opportunity becomes recommendation **`wait`** while its score
  stays untouched. `publicAt` is only set when the countdown parses unambiguously (fetch time + countdown);
  otherwise it stays empty and the raw label is preserved. Old stored rows have unknown access. Nothing
  is ever bought or clicked, and the opportunity must be refreshed before any future application.
- **Notifications.** Independent state per AI result (`analyses.notified_at`): a new opportunity that has
  an analysis gets one **enriched** message; one already notified gets a single separate **AI update**;
  without an analysis (AI off or failing) the basic message goes out as before. A clear AI `skip` is never
  announced and withholds the basic message. Headers: `🟢 APPLY`, `🟡 REVIEW`, `🕒 WAIT — PREMIUM ONLY`.
  With `DRY_RUN=true` nothing is sent or marked, and Gemini is not called.

Set the key only in your local `.env` (`GEMINI_API_KEY=`); never paste it in chat or commit it.

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
| `npm run ai:analyze`     | Analyze pending opportunities (`-- --limit N`, `-- --only <id>`, `-- --force`); no site access |
| `npm run analyses`       | Show stored AI analyses by recommendation (`-- --proposals`, `-- --messages`); discards drafts of superseded versions |
| `npm run access:refresh` | Re-read one opportunity's detail (`-- --id <sourceId:externalId>`, 1 request) and update only its access |
| `npm test`               | Offline tests (Node's built-in runner; no network, no Telegram, no Gemini) |
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
| `AI_ENABLED`                | `false`                 | `true` turns AI analysis on (anything else keeps it off)   |
| `AI_PROVIDER`               | `gemini`                | Only `gemini` exists; no automatic fallback                |
| `AI_MODEL`                  | `gemini-3.6-flash`      | The single model used                                      |
| `GEMINI_API_KEY`            | —                       | Required only for real AI requests (not in dry-run)        |
| `AI_MAX_ANALYSES_PER_RUN`   | `20`                    | Analyses per run, 1-20 (invalid value fails when AI is on) |
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
  profile/                       InterestProfile + Don Bruno's interests; CandidateProfile (skills, capabilities)
  ai/                            Analyzer contract, Gemini client, prompt, output validation, batch runner
  domain/match-analysis.ts       MatchAnalysis, ProposalDraft, actionability (provider-independent)
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
