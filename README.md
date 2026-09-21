# Job Sniper

## Mission

Job Sniper watches freelance and job platforms for new opportunities, filters
them against defined criteria, and notifies the owner quickly so they can
respond before the competition does.

The domain model is platform-independent. Each platform is an adapter behind
a common contract, so the core never depends on a specific website.

## Pipeline

1. **Collect** — list recent opportunities from a source and save every summary in a persistent queue.
2. **Deduplicate** — skip opportunities already known (SQLite).
3. **Enrich** — fetch details for queued opportunities only (`OpportunitySource.fetchDetail`).
4. **Filter** — classify each opportunity against the interest profile.
5. **Analyze (optional)** — AI compatibility analysis, price range and proposal draft, in batches of up to 20.
6. **Notify** — send opportunities to Telegram in Portuguese, once each; each AI analysis is one compact message.

The stages are isolated: a failure in one never blocks delivering what is already saved.

## Current flow

`npm run dev` runs one pass made of three independent stages:

1. **Collect.** Re-evaluates stored opportunities whose filter result came from another rule version
   (offline), then discovers opportunities page by page, newest first (see "Discovery" below).
   Every summary is saved **before** any detail request. Known ones only get `last_seen_at` updated.
   `npm run collect` runs this stage alone.
2. **AI (optional).** If `AI_ENABLED=true` (and `DRY_RUN=false`), analyzes pending opportunities by priority
   (see "AI analysis" below), under the quota controls. A quota pause or an AI failure is reported and does
   not stop the next stage.
3. **Notify.** Sends what is owed, from the whole database (not only what this run found). Each AI analysis
   is delivered as ONE compact Telegram message, stored before it is sent; the completion flags
   (`opportunities.notified_at`, `analyses.notified_at`) are written **only after Telegram confirms it**.
   A run that stops halfway resumes the stored message without repeating one already confirmed.

## Sources

`SOURCES` (comma separated) chooses what each run collects: `99freelas` (the default, unchanged), `remotive`, `freelancer`, or any
combination. Remotive and Freelancer.com are **off by default**.
Each source runs with **its own limits** and its own identifiers (`sourceId:externalId`), so one never spends the
other's budget, and a failure or a block in one is reported without stopping the other, the AI stage or the delivery of
what is already stored. `npm run collect` and `npm run dev` both use this selection.

**Freelancer.com** (official API, `https://www.freelancer.com/api/projects/0.1/...`; no scraping, no browser, no SDK).
- Enable with `SOURCES=99freelas,freelancer` and a **Personal Access Token** in the local `.env` (`FREELANCER_OAUTH_TOKEN=`), sent only in
  the `Freelancer-OAuth-V1` header, never in a URL, a log or an error. Without the token only this source is skipped, with a short
  message. The token is **valid for 30 days**: on a 401 the source stops, says the token may have expired and is left alone for at
  least 6 hours (a stored cooldown; 403 and 429 too, or `Retry-After` if longer). Safe renewal: create a new token in your Freelancer.com
  developer account, replace the value in `.env` yourself (never paste it in chat, commits or screenshots) and run the collection again.
- Listing: `GET /api/projects/0.1/projects/active/` with `jobs[]` (skill ids), `from_time` (last 7 days), `sort_field=submitdate` (newest
  first; `reverse_sort=true` would return the OLDEST first), `limit`/`offset` (20 per page, `FREELANCER_MAX_PAGES` pages, default 5,
  range 1 to 10; this setting is read by no other source), `full_description` and `job_details`. Skill ids come from `GET /api/projects/0.1/jobs/?job_names[]=...`, looked
  up from the profile's strong skills and kept 24 hours. Detail: `GET /api/projects/0.1/projects/<id>/`; a project listed in the same run
  is used as it is, an older one is fetched again. The text search parameter (`or_search_query`) did not filter, so skills are filtered by id.
- Kept: id, title, page URL, real publication instant (Unix time), status (`active` is open), fixed or hourly budget with its **original
  currency code** (never converted), number of proposals, skills, language and audit metadata.
- **Cache rule (API terms):** cached data must be refreshed at least every 24 hours. Alerts are sent only from data collected within 24 hours;
  an unsent opportunity older than that is withheld and reported (`withheld (data too old)`), never sent from stale data and never marked
  as delivered. Identity, decision and delivery history stay stored for deduplication. Status is confirmed at collection time only, so a
  project can close between the collection and the alert.
- **Personal use versus a service:** the terms allow personal and internal use. A multi-user or sold service needs its own OAuth application
  per user or Freelancer.com's written permission, cannot share one token, and needs a fresh review of the terms (no redistribution or
  syndication of API access, no competing with Freelancer.com, deletion of stored data on termination). Not implemented.

**Remotive** (`remotive.com/api/remote-jobs?category=software-dev`, the documented public API; no browser, no page scraping).
Version 1 looks for **freelance technology projects with a defined deliverable**: full time, part time, internship, ongoing team
roles and, for now, plain `contract` jobs are **stored but never alerted** (a contract says nothing about a defined project).
A jobs mode with its own analysis is a later step.
- One response holds every job with its description, so a run makes **at most one request** and reads each job's "detail" from
  that stored response, never one request per job. The response and the time of the last attempt are kept in the database
  (`source_cache`), so they survive restarts.
- **Minimum 6 hours between queries** (`REMOTIVE_MIN_INTERVAL_HOURS`, never lower; the API documentation advises at most 4 a
  day). Runs in between reuse the cache. A failed attempt counts as a query and is not repeated in sequence (the older
  response keeps being served). HTTP 429 or 403 stops querying until `Retry-After`, or the interval if longer.
- Identity is the API `id`. Kept as published: original Remotive URL, title, company, category, tags, hiring type, required
  location, pay text and publication date. HTML in the description is turned into plain text without ever rendering it.
  Missing fields stay unknown. The pay text is **never** converted or treated as a budget (no currency, period or
  annual-versus-hourly is inferred), and a publication time without a time zone is not turned into an instant.
- The API says its jobs are delayed 24 hours (so an alert can be up to a day late), and that a link back to Remotive and a
  mention of Remotive as the source are required; the Telegram message does both. The delay is documented here, not repeated in
  every alert. Personal use only for now; the terms do not allow passing the jobs on to other
  sites, and a public or paid service would need Remotive's permission (it offers a paid private API).
- The category parameter did **not** restrict the response in the first real query (jobs of Writing, Design and others came
  back, 20 in total), so relevance is decided locally, see the filter below.
- AI analysis is **not** applied to Remotive: the prompt, the price suggestion (BRL) and the proposal draft are written for
  freelance projects. Its opportunities are announced from the collected data and the basic filter only (no score, suggested
  price or proposal). `ai:analyze -- --only remotive:<id>` still works explicitly.

## Discovery (persistent queue)

Each run starts at the newest listing page. One page is read at a time (sequential, with the usual delay);
every summary is compared with the database. New summaries are saved in the `discovery_queue` table
**before** any detail is requested, so a *known* opportunity is not the same as one whose *details were
obtained*. Queued items survive restarts and stay there after they scroll out of the listing.

Three limits are independent, and the first one reached stops the scan:

| Limit                  | Default | Counts                                                    |
| ---------------------- | ------- | --------------------------------------------------------- |
| `DISCOVERY_MAX_PAGES`  | 20      | listing pages read                                        |
| `DISCOVERY_TARGET_NEW` | 100     | **new** summaries saved (already-known ones do not count) |
| `MAX_DETAILS_PER_RUN`  | 20      | detail pages opened                                       |

`DISCOVERY_TARGET_NEW` changed meaning in this version: it used to count opportunities collected for detail
fetching; now it counts new summaries, because the details no longer have to be fetched in the same run.

The detail budget is split: half (rounded down) is reserved for older pending items (oldest first) and the
rest goes to the newest ones; whatever one group does not use flows to the other. A detail failure keeps the
item pending with a growing wait (15 min, doubling, up to 24 h). Only a definitive answer (HTTP 404/410 or the
site's own "page unavailable" page) twice in a row marks it `unavailable`; a temporary error never does.

Pagination stops at the first of:

| Stop reason          | Meaning                                                                        |
| -------------------- | ------------------------------------------------------------------------------ |
| `target-new-reached` | `DISCOVERY_TARGET_NEW` new summaries were saved                                |
| `max-pages-reached`  | `DISCOVERY_MAX_PAGES` pages were read                                          |
| `source-exhausted`   | the source has no next page, or returned an empty page                         |
| `repeated-page`      | a page brought no ID that this run had not already seen                        |
| `no-progress`        | the next cursor points back to a page already requested                        |
| `blocked`            | HTTP 403/429 or a CAPTCHA/challenge page: everything stops, no further request |
| `source-error`       | any other listing failure; what was already collected is still processed       |

The report shows pages read, discovered / already known / new, details attempted / obtained / failed /
unavailable, and the queue state (pending, done, unavailable), so the numbers always add up.
Notifications stay once-only: discovery never touches `notified_at`.

A source exposes pagination through one small contract: `listRecent(cursor?)` returns
`{ items, nextCursor }`, where the cursor is opaque to everything except the source (for 99Freelas it
is the page number). Nothing platform-specific reaches the domain.

## AI analysis (optional, Gemini free tier)

Off by default (`AI_ENABLED=false`); with it off, everything else works exactly as before.
When on, after discovery the program analyzes **pending open opportunities, up to
`AI_MAX_ANALYSES_PER_RUN` (at most 20)**, one request at a time, under the quota controls below.
Cancelled, closed and unknown-status opportunities are never analyzed. An opportunity is never analyzed
twice for the same **analysis version** unless forced.

**Selection priority.** Opportunities the deterministic filter marked `shortlist` or `review` come first;
`skip` ones are kept aside and only analyzed with `-- --only`. Never-attempted opportunities go before ones
whose earlier attempt failed, and a failed one is retried at most 3 times (then it is reported as exhausted
until forced). Inside a group, the newest and the longest-waiting opportunities alternate. Skill aliases (for
example "responsive layouts" for responsiveness) are normalized in the verification without confirming
anything: the skill stays `unverified`. Successes of an older version are never invalidated in bulk.

**Gemini quota controls.** Requests start at least `GEMINI_MIN_INTERVAL_SECONDS` (15) apart, retries included.
A per-model **daily counter** (`GEMINI_MAX_REQUESTS_PER_DAY`, default 20) is stored in the database, and one
unit is reserved *before* each call (a retry counts as a request). The quota day rolls over at midnight in
`America/Los_Angeles`, not in Brasília time. A lock stops two runs from using the free tier at once and
recovers itself after a crash. On HTTP 429 the program reads `Retry-After` and the quota details, stores a
**cooldown** and stops the batch; later runs do not even try until it expires (an unknown quota kind gets a
short cooldown, never an invented daily reset). The counter only covers requests made **since this version
was installed**; earlier usage is unknown to the program, so the real quota may be lower than the counter
shows. Reports separate requests made now from the daily total, so nothing is counted twice.

Per opportunity the model returns, and the program validates locally: score 0-100 (technical fit only),
confidence, recommendation (`apply`/`review`/`skip`), fit explanation, matched and missing skills,
risks, questions for the client, effort range, complexity, a BRL price range with rationale, and a
proposal draft in Brazilian Portuguese. Invalid, incomplete or out-of-range answers are **never stored
as a success**. The AI result is stored **next to** the deterministic `basic-v3` decision, never over it.

- **Skill verification.** The candidate profile (`src/profile/bruno-candidate.ts`) separates **confirmed**
  (verified by the owner), **unverified** (an interest; competence not verified), **learning** and
  **unavailable** skills, plus the owner's declared context (currently: a beginner working with guidance and AI,
  no complete landing page published yet). Nothing is confirmed until the owner says so. The model lists every
  **essential** skill for the delivery; an `apply` stands only if there is at least one and **all** of them are
  confirmed (one confirmed skill never compensates for another essential one that is unverified, being learned
  or outside the profile). Otherwise it becomes `review`, confidence is capped at `medium`, and the uncertainty is
  spelled out. Proposals may not assert competence. The score is a technical-fit rating, not a probability.
- **Analysis version.** Results are stored per opportunity and version = prompt version + a fingerprint of the
  profile (`ai-v3+p…`). Changing the profile in a relevant way makes everything eligible again; older results
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
  HTTP 429 (quota) stops the batch and stores a cooldown: completed analyses stay saved, the rest stay pending. Timeouts,
  network errors and 5xx get exactly one retry; three outages in a row end the batch. A bad key or model
  stops the batch without blaming any opportunity. Failed opportunities are recorded (with a trimmed,
  secret-free message) and retried by a later run, up to 3 attempts.
- **Restricted access.** A source can mark an opportunity as `premium_only` (99Freelas: "Projeto
  Exclusivo", which opens to everyone after a countdown). The candidate's 99Freelas account is recorded
  as **free**, so a compatible restricted opportunity becomes recommendation **`wait`** while its score
  stays untouched. `publicAt` is only set when the countdown parses unambiguously (fetch time + countdown);
  otherwise it stays empty and the raw label is preserved. Old stored rows have unknown access. Nothing
  is ever bought or clicked, and the opportunity must be refreshed before any future application.
- **Notifications.** Independent state per AI result (`analyses.notified_at`): a new opportunity that has
  an analysis gets one **enriched** delivery; one already notified gets a single separate **AI update**;
  without an analysis (AI off or failing) the basic message goes out as before. A clear AI `skip` is never
  announced and withholds the basic message. See "Telegram messages" below.
  With `DRY_RUN=true` nothing is sent, stored or marked, and Gemini is not called.

Set the key only in your local `.env` (`GEMINI_API_KEY=`); never paste it in chat or commit it.

## Telegram messages (Portuguese)

The text sent to Telegram is in Brazilian Portuguese (the code and everything else stay in English). Every alert is **one compact
message** (under 1,000 visible characters) in the same visual layout, built only from stored data; the AI is never called to format it:

```text
🚨 NOVA OPORTUNIDADE

🟢 OPORTUNIDADE COMPATÍVEL

Título
🌐 Freelancer.com · 🆕 Publicada hoje

💰 Orçamento: INR 12.500–37.500
👥 Concorrência: 12 propostas
🧰 Tipo: preço fixo
🎯 Compatibilidade: alta

📝 O projeto
Resumo curto, com no máximo duas frases.

🤖 Como a IA pode ajudar
Acelerar a estrutura inicial, os componentes e a revisão responsiva. Você ainda controla briefing, decisões e entrega.

⚠️ Atenção
Principal ressalva relevante.

🔗 Abrir oportunidade
```

- **Header** says why the message exists: `🚨 NOVA OPORTUNIDADE` (a real new opportunity), `🧪 PRÉVIA DE FORMATO` (a manual preview only) or
  `🔄 ANÁLISE ATUALIZADA` (an older opportunity whose analysis arrived later). A real opportunity never carries preview wording.
- **Classification (the commercial ladder):** `🔵 MATCH EXCELENTE` (top match), `🟢 OPORTUNIDADE COMPATÍVEL` (shortlist, or an AI "apply"), `🟡 VALE REVISAR` (review), `🕒 AGUARDAR LIBERAÇÃO` and `🔴 NÃO VALE A PENA` (AI only).
- **Facts:** the client's budget (see "Budget in the preferred currency" below; never called a suggested price), competition, fixed or hourly, at most
  four relevant skills (only those the filter found, only when there are any), and the compatibility in words (the current deterministic filter:
  high, medium or low). For a jobs source (Remotive) the facts are the pay as published, the type and the required location.
- **Effort and suggested price appear only when a saved AI analysis exists**, and never otherwise. Nothing is invented.
- **📝 O projeto** is the first *substantive* stretch of the description, at most two short sentences, in the author's own words: greetings
  ("Hello!", "Hi there", "Olá", "Bom dia", "Dear freelancer"), labels ("Descrição:", "Project description", "Objective", numbering), very short lines
  (under about 30 characters), generic headings and pleasantries are skipped. With nothing useful the block is omitted.
- **🤖 Como a IA pode ajudar** is one fixed sentence chosen by rules from what the title and description say (WordPress, front-end named
  technologies, automation or bots, API or integration, bug fixes, or a plainly stated request to build a site). It describes what AI can speed
  up and never says the person masters the skill. Skill tags alone never create it; with no clear or safe signal (advanced scope, skills only in
  tags, a skipped project) the block is omitted.
- **⚠️ Atenção** holds only the single main caveat, by priority: restricted access, project language, advanced scope, high competition (61+
  proposals on a marketplace), then the most relevant stored reason (location, type, seniority, skills only in tags, unverified skills).
- The complete analysis and the proposal draft stay in the database; read them with `npm run analyses -- --details --proposals`
  (`--messages` shows the message as it would be sent). Interactive buttons are not implemented. Over-long fields are shortened in steps;
  a tag or link is never cut, and all external text is HTML-escaped.

**Delivery state.** The message is stored (`deliveries`, `delivery_parts`) before sending and receives the Telegram
`message_id` once confirmed. The analysis is marked notified only after confirmation, and a message already confirmed is
never sent again. Changing how messages look never re-sends history.

**Former multi-part deliveries.** An earlier format sent a summary plus detail parts. A delivery of that format that
never completed is **not** resumed and its unsent parts are **not** marked as delivered. If at least one part had reached
the owner, the analysis is held (not announced again); if nothing had reached the owner, it is delivered in the compact
format. The notification report lists these cases.

**Known limit (exactly-once).** If Telegram accepts a message but the confirmation is lost (timeout or network error
after sending), the program cannot know. It is recorded as *ambiguous* and reported, and it is retried on the next run,
so in rare cases one message may appear twice. It is never silently dropped.

`npm run notify:demo -- --id <sourceId:externalId> [--label x]` (older, deduplicated by label; the everyday tool is `notify:preview`) sends **one** message with the header "🧪 PRÉVIA DE FORMATO" for a
saved opportunity (its saved analysis if it has one, otherwise its basic message; no AI, no site access). It is stored as its own delivery, so it
never marks the real notification, and repeating it with the same label sends nothing new. With `DRY_RUN=true` it only prints and writes nothing.

**The commercial ladder and the ranking.** Every opportunity ends in one of four decisions: `top_match` (🔵 excellent match), `shortlist` (🟢 compatible
opportunity), `review` (🟡 worth reviewing: a real doubt or gap) and `skip` (never notified). Technical compatibility is judged **apart from
attractiveness**: budget, competition and recency lower the ranking and add caveats, they do not turn a technically compatible project into a review
or a skip. Everything is stored, but a run sends at most `MAX_TELEGRAM_ALERTS_PER_RUN` (5) Telegram alerts **in total, across all sources**, best
first: top matches, then shortlist, then review (see "Antiflood" below for which opportunities compete). Inside each group: (1) a very crowded project (more than 150 proposals) goes last; (2) a clearly
relevant main task first; (3) the most recent publication day (Brasília calendar day; unknown last); (4) fewer caveats; (5) the better budget
(reaches the floor, crosses it, no fresh conversion, below it); (6) fewer proposals; (7) more strong skills; (8) the stable `source:id`, so the order
never depends on insertion order. Data older than the source allows is withheld and does not use a slot. The cap is never lifted to make room. All
sources take part in the ladder, including 99Freelas (a source that publishes no engagement type is a freelance projects source); an unknown budget
never blocks a green and always blocks the blue.

**Antiflood: a persistent alert batch per collection (schema version 6).** Only the opportunities **stored for the first time by the collection** compete
for its alerts. The best `MAX_TELEGRAM_ALERTS_PER_RUN` of them (blue included; top match, shortlist, review, by the ranking above) are recorded in
`alert_queue` as `selected` **before anything is sent**, and stay owed until Telegram confirms them: a failed send is retried by the next run, ahead of
any new selection, and the free slots are the cap minus what is still owed. The others of that collection are recorded as `overflow`; everything older
is **backlog**. Overflow and backlog are stored and consultable but are **never alerted automatically** and their `notified_at` is never touched: only
a confirmed Telegram delivery writes it. A selected item whose data goes stale (24 hours for Freelancer.com) is released (`expired`). `npm run
collect` records the batch too (it sends nothing); `DRY_RUN` renders it and marks nothing. The backlog is sent only on purpose:
`npm run backlog` lists it, best first (read only); `npm run backlog -- --send [--limit N]` sends the best N (default the cap, at most 20), obeys
`DRY_RUN` and the 24-hour data rule, and marks only what Telegram confirms.

**Budget in the preferred currency.** With `DISPLAY_CURRENCY` (default `USD`) and a fresh rate, the budget line shows the converted value first with `≈`
and the original below, keeping fixed or hourly: `💰 Orçamento: ≈ US$ 6–16` / `↳ Original: INR 600–1.500`, or `≈ US$ 8–13/h` / `↳ Original: INR 750–1.250/h`.
A budget already in that currency is one line (`US$ 10–20/h`). Without a fresh rate (absent or older than 24 hours) only the original is shown. Only
rates the source itself published and the database stored in `exchange_rates` are used: **no external exchange-rate service is ever queried**, the
original amounts are never changed, and the caveat block never repeats the conversion ("Faixa de orçamento atravessa o piso de US$ 8/h.").

**Personal daily limit.** `MAX_TELEGRAM_ALERTS_PER_DAY` (default 10, 1 to 1000; anything else fails with a message naming it) is a global limit of alerts
**automatic** alerts confirmed per calendar day in `America/Sao_Paulo`: only what a collection selected and Telegram confirmed (later, what the agent
selects) counts. It is read from the persistent records (`notified_at` of a queue-selected opportunity), so it survives restarts and turns over at
midnight in Brasília. It is **not** a ban on using Telegram: the owner's manual paths below ignore it. The run limit (`MAX_TELEGRAM_ALERTS_PER_RUN`) and
the day limit both apply to automatic alerts, the smaller wins; blue ones keep their priority but never exceed the day. Selected alerts are never lost: what the day could not carry stays selected and unmarked and goes out on a
later day (while its data is fresh). Overflow and backlog are never drained by the new day.

**Three paths to Telegram.**

| Path | Command | Daily limit | Marks `notified_at` | Repeatable |
| ---- | ------- | ----------- | ------------------- | ---------- |
| Automatic alert | `npm run dev` (collection) | applies (per run **and** per day) | yes, after Telegram confirms | it is retried until confirmed, never duplicated |
| Manual preview | `npm run notify:preview -- --only <source>:<id> [--send]` | never used | **no** | any number of times |
| Manual real delivery | `npm run notify:manual -- --only <source>:<id> [--send]` | ignored (the only rule it ignores) | yes, after Telegram confirms | no: an opportunity already delivered is refused |

- **Exactly one** `<source>:<id>` per command (for example `freelancer:40725242`). A list, a repeated `--only`, `all` or any implicit batch is refused.
- **Without `--send`** both only print the message: nothing is sent, stored or marked. A real send needs all three of: an explicit `--send`, `DRY_RUN=false`
  and valid Telegram credentials (their absence is reported by variable name). With `--send` and `DRY_RUN=true` the command fails at once with
  "Envio bloqueado: DRY_RUN=true. Defina DRY_RUN=false para autorizar envio real.", before touching Telegram or the database.
- **Preview** carries the mandatory header "🧪 PRÉVIA MANUAL", is stored as a delivery of kind `demo` with a unique reference, never touches `notified_at`,
  the alert queue or a production delivery, and never calls the AI. It can show any stored opportunity, delivered or not (a preview of data older than the
  source's limit only prints a warning; nothing else uses that data).
- **Manual delivery** still requires a deliverable decision (a skip never is), a valid http(s) link, a title, data fresh for its source (24 h for
  Freelancer.com) and credentials. An opportunity already delivered is not sent again as a new alert: use the preview. If a collection had already
  selected it, the delivery moves it out of the automatic count.
- **Counting.** Reports keep three numbers apart: automatic alerts used today (the only ones against the limit), manual real deliveries, and manual previews.
  `npm run backlog -- --send` and `notify:analyses` are manual too and never use the daily limit.

## Hunter (SPEC 008): commands by Telegram and a schedule

**Architecture.** OpenClaw (the owner's personal agent, official project `openclaw/openclaw`) is only the command and scheduling layer. Job Sniper remains the
deterministic engine (collection, filter, ranking, queue, deduplication, Telegram). They meet at ONE small façade, `npm run hunter` (`dist/cli/hunter.js`): fixed verbs,
validated arguments, **one line of JSON** on stdout: `{ "ok", "code", "command", "reply", "data" }`. The agent never imports Job Sniper code and never runs a free command;
its exec permission is a single program with fixed argument shapes (`openclaw/exec-approvals.example.json`, kept identical to `src/agent/openclaw-contract.ts` by a test).

| Say to the agent | Façade verb | What it does |
| ---------------- | ----------- | ------------ |
| `status` | `status` | Read only: enabled sources, mode (DRY_RUN or real), the last round (new, by class, delivered, waiting), automatic quota used and left today, manual deliveries and previews, next scheduled hunt, last error |
| `caça agora` / `caça agora só no Freelancer` / `…só no 99Freelas` | `hunt [source]` | One run of the normal pipeline (`src/index.ts`) as a child process, with the AI stage off and the Gemini key blanked; one at a time (lock file); no retry after a failure |
| `mostre as N melhores` (1 to 10) | `top N` | Read only: the fresh, non-skip entries of the latest round in the persisted ranking order: class, title, source, budget, proposals, age, `source:id` |
| `libere mais 5` | `more` | Manual and explicit: sends the next lot of AT MOST 5 (fixed) of the latest round, in its persisted order, through the manual delivery (`notify:manual` rules); a skip, a stale, an invalid or an already delivered one is passed over without using a place; a Telegram failure stops it and keeps everything pending; it does **not** use the automatic daily quota and is reported apart; with `DRY_RUN=true` it only says what it would send |
| `ajuda` | `help` | The catalogue |

Anything else is refused by the façade itself (applying to jobs, changing the profile, "run this command", four sites, a number out of limits, a source outside Freelancer / 99Freelas
/ the enabled ones). `ask --text "<phrase>"` is the deterministic parser for the owner's sentences (no model is involved in understanding them).

**Safety.** Only the one Telegram user in `HUNTER_OWNER_TELEGRAM_ID` is obeyed, and only in a private chat (`--sender` and `--chat` must both equal it); anyone else, a group or a
channel gets silence and nothing runs. Titles, descriptions and any platform text are data: titles are cleaned to one short line (control, zero-width and direction characters removed)
and descriptions never appear in an answer. `DRY_RUN=true` blocks every send. Errors name a variable, never a value. Every action is logged (without ids or secrets) in `data/hunter.log`.

**Schedule.** Off by default (`HUNTER_SCHEDULE_ENABLED=false`). A periodic `hunter tick` (every few minutes, from the OpenClaw scheduler or the operating system) runs the same hunt only inside a
configured slot (`HUNTER_SCHEDULE_TIMES`, default 09:00 and 17:00 in `HUNTER_TIMEZONE`, default America/Sao_Paulo), within 20 minutes after it. A slot is written down before it runs, so a second tick,
a restart or a failure never repeats it, and a slot that arrives while another hunt runs is delayed, not lost; a slot the machine missed is not made up. State is kept next to the database
(`<db>.hunter.json`, `<db>.hunter.lock`); the SQLite schema is unchanged (still v6).

**Setting OpenClaw up (one time, by the owner).** OpenClaw 2026.9.x needs Node 24.16+ (below 25) or 26.1+ and a model provider credential of its own; neither is part of this repository.
`openclaw/` holds an example configuration (Telegram allowlist with the owner's id, one tool, exec approvals) and the skill; they were written from the official documentation and are to be
checked with `openclaw doctor` at installation. The bot token stays in `.env` / OpenClaw's own secret store, never in these files.

## Filter (`basic-v10`)

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

**Jobs sources (engagement policy).** For a source that publishes jobs (Remotive), a second step runs after the skill rules and can
only lower the result: full time, part time, internship and contract are **skipped** (stored, not sent automatically; a contract is
never assumed to be a short project); a category that is clearly not technology (Writing, Design, Sales, ...) is **skipped** even
when the text mentions a skill word; a freelance job that reads like a continuing team role ("join our team", "long term",
"ongoing") is **skipped**; a missing or unrecognized type is at most `review` and never shown as freelance; a location that names only other countries or regions (for example "USA Only") is
**skipped**; a location that is "Remote" alone, a time zone, "Worldwide except ...", missing, or restricted in the description
(residence, work authorization) is at most `review`; a senior title is at most `review`. "Worldwide", Brazil, LATAM, South
`America and the Americas are compatible. "Remote" is never read as worldwide. A strong skill that appears only in the skill **tags** (never in the title or description) is at most `review` for these sources.
Freelancer.com projects are freelance by nature and have no location requirement, so only the type, category, team-role, seniority and
tag rules apply to them. Projects from 99Freelas publish no engagement type or location: they are freelance projects, judged by the same category,
main-task, central-skill, specific-skill and back-end rules (in Portuguese too), with no type or location invented.

**Freelance projects (`basic-v10`).** For every source: Freelancer.com and Remotive publish an engagement type, and a source that publishes none
(99Freelas) is a freelance projects source. A second step runs after the skill rules and only lowers the result, except the last one, which may name
an excellent match. **A green (`shortlist`) needs the central task inside the offered skills and a SPECIFIC skill in the title or the start of the
description (about the first 100 words, 600 characters).** "Responsive", "front-end", "site", "web", "website" and the skill tags are generic and
prove nothing alone (`genericSignalTerms` in the profile); HTML, CSS, JavaScript, TypeScript, React, WordPress, landing page, API, integration,
automation, bot and Telegram are specific:

- **`skip`** (irrelevant, closed, not technology, out of scope, prohibited or incompatible): **prohibited or suspicious activity**, when the central goal is to
  fabricate views, clicks or impressions artificially (for example a service that automatically loads and "watches" ~1,000 banner ads a day to register
  impressions behind rotating proxies). It is judged by whole sentences (an automatic means asked to boost or generate the metric, a fake or inflated result,
  or automatic loading/clicking plus a stated daily volume or an effort to look natural), never by an isolated word: tracking pixels, analytics and
  ad-verification work are ordinary; a category that is not technology; a **main task that is not
  technical** (payroll, story writing, trading, copywriting, translation, data entry, **chat support, customer support, virtual assistant**, and marketing
  such as **ads and SEO** when the title names no strong technical skill); a **central skill the profile does not offer** (another language such as Python
  or Rust, native or cross-platform mobile apps, games, machine learning, DevOps, blockchain, and site platforms such as Shopify, Webflow and Wix...)
  in the title, or at the start of the description with no specific skill beside it (a platform is outside the profile only while it is not one of the
  profile's configured skills: list it in the strong signals and it is offered); **back-end or full-stack work as the central task** (Laravel, Node.js,
  scraping, WebSocket feeds, multi-tenant SaaS, or sign-up + login + uploads + a database) when nothing specific of the profile is named up front, or
  when three or more back-end signals dominate the start; a continuing team role; a location that excludes residents of Brazil. These are general rules with vocabulary in
  `src/profile/don-bruno.ts` (`offTopicTasks`, `offTopicUnlessStrong`, `unavailableSkills`, `backendWork`), not exceptions by id.
- **`review`** (a real doubt or gap): an unclear main task (no technical deliverable in the title or the first 600 characters of the description, or title and
  description disagree); **no specific technical skill up front** (only generic words); an essential skill outside the profile, or back-end work,
  **beside** an available specific skill (ambiguous); a strong skill named only in the skill tags; a senior
  title; an advanced scope; a **very short deadline** (24 hours or less, written in the text); a **transactional main delivery**; a missing or unrecognized
  type; an ambiguous location; a language outside the profile.
- **`shortlist`** (technically compatible): everything else with a strong skill in the text. A **low or crossing budget** and **competition** are caveats
  that lower the ranking and appear as a warning in the message; they never cap or remove it.
- **`top_match`**: a shortlist that also has a strong skill in the title or the start of the description, a small or medium scope (no large-scope word,
  not a very long brief), a description with at least 150 characters, a **known budget whose bottom fully reaches the floor**, and **at most 60 proposals**
  (when the count is published). Any doubt or a missing budget keeps it a shortlist.
- **Transactional scope is contextual.** Only when the main delivery is payments, checkout, subscriptions, ticketing or bookings: a payment word in the
  title, a strongly transactional delivery at the start of the description (recurring billing, multiple gateways, custom checkout, ticketing...), or a
  payment object right after an implementing verb ("integrate a payment gateway", "fix the billing"). A shop that just says customers pay with PayPal is an
  ordinary shop.
- **Budget.** The original budget and currency are kept exactly as the source states them. The filter compares the range with the floors **US$50**
  (fixed) and **US$8/h** (hourly), defaults in `budgetFloors`, as an internal USD equivalent that is never shown converted in Telegram. A range whose
  top is under the floor ("Orçamento baixo para o escopo; avalie se compensa pelo portfólio, avaliação ou experiência.") and a range that crosses it
  (shown as `US$ 16–130`) are caveats. A missing bound is treated as open.
- **Exchange rate, per source and currency, valid for 24 hours.** USD needs none. Any other currency uses the rate the official Freelancer.com API
  published (`currency.exchange_rate`), stored in the table `exchange_rates` by `(source_id, currency_code)` with `observed_at` and reused by every stored
  opportunity of the same source and currency, with no request per opportunity. Older than 24 hours, or absent, it only **withholds the top match**: the
  opportunity stays, the original budget is never changed and nothing is estimated. Rates already saved inside stored rows seed the table once, at the
  version 5 migration.
- **Competition.** Up to 60 proposals is normal; more than 60 is a caveat; more than 150 is still relevant, but goes last of its own group.

Telegram's "Como a IA pode ajudar" follows the **central task**: the title decides, and only when the title names none the start of the description
(about its first 60 words) does; in each, the order is bug or error, then API or integration, then WordPress, then front-end, then automation. A word such
as "integration", "error" or "fix" further into the text never decides it; with no central signal the block is omitted.

**Persistence (schema version 5).** `top_match` is a new accepted value of `opportunities.filter_decision`; SQLite cannot change a CHECK, so the table is
rebuilt once, copying every row as it is (`first_seen_at`, `notified_at`, payloads, analyses and deliveries untouched), after the automatic
`<name>.pre-v5.db` backup, which the program never deletes. Changing the rule version re-evaluates only the filter columns, offline.

When the rule version changes, stored decisions are re-evaluated automatically (see below).

## Commands

| Command                  | Description                                                              |
| ------------------------ | ------------------------------------------------------------------------ |
| `npm run dev`            | One full pass: collect, AI (if enabled), notify                          |
| `npm run collect`        | Collect only, for the sources in `SOURCES` (no AI, no Telegram)          |
| `npm run opportunities`  | List stored opportunities by shortlist / review / skip (read-only view)  |
| `npm run telegram:test`  | Send `🎯 Job Sniper online.` (printed only when `DRY_RUN=true`)          |
| `npm run ai:analyze`     | Analyze pending opportunities (`-- --limit N`, `-- --only <id>`, `-- --force`); no site access |
| `npm run analyses`       | Show stored AI analyses by recommendation (`-- --details`, `-- --proposals`, `-- --messages`); discards drafts of superseded versions |
| `npm run notify:analyses`| Deliver saved analyses to Telegram; never calls Gemini                   |
| `npm run notify:demo`    | One demonstration delivery of a saved analysis (`-- --id <id> [--label x]`) |
| `npm run notify:preview` | A "🧪 PRÉVIA MANUAL" of exactly one stored opportunity (`-- --only <source>:<id> [--send]`); repeatable, marks nothing |
| `npm run notify:manual`  | The real delivery of exactly one never-delivered opportunity (`-- --only <source>:<id> [--send]`); ignores only the automatic daily limit |
| `npm run hunter`         | The Hunter façade (`status`, `hunt`, `top`, `more`, `help`, `ask`, `tick`): one JSON line; owner only (`--sender` and `--chat`) |
| `npm run backlog`        | List the owed backlog that automatic alerts never send (read only); `-- --send [--limit N]` sends the best N on purpose (obeys `DRY_RUN`) |
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

The schema version is kept in `PRAGMA user_version` (now **4**). Opening an older database migrates it
automatically and idempotently (only new tables are added; existing rows are untouched), after first
copying it to `<name>.pre-v<N>.db` next to it (for example `job-sniper.pre-v4.db`, also git-ignored).
Version 3 adds `discovery_queue`, `deliveries`, `delivery_parts`, `quota_usage`, `quota_state` and `run_locks`. Version 4 adds `source_cache` (the stored Remotive response and the time of its last attempt).

## Environment variables

| Variable                    | Default                 | Purpose                                                    |
| --------------------------- | ----------------------- | ---------------------------------------------------------- |
| `DATABASE_PATH`             | `./data/job-sniper.db`  | SQLite file location                                       |
| `MAX_DETAILS_PER_RUN`       | `20`                    | Max detail requests per run (invalid value → `20`)         |
| `DISCOVERY_MAX_PAGES`       | `20`                    | Most listing pages read per run (positive integer, else the run fails) |
| `DISCOVERY_TARGET_NEW`      | `100`                   | Stop paginating after this many **new** summaries were saved (positive integer, else the run fails) |
| `SOURCES`                   | `99freelas`             | Sources collected per run: `99freelas`, `remotive`, `freelancer`, comma separated |
| `FREELANCER_OAUTH_TOKEN`    | —                       | Freelancer.com Personal Access Token (30 days); only the Freelancer source needs it |
| `FREELANCER_MAX_PAGES`      | `5`                     | Freelancer.com listing pages (20 projects each) per run, 1 to 10 (else the run fails); no other source reads it |
| `REMOTIVE_MIN_INTERVAL_HOURS` | `6`                   | Hours between Remotive queries, at least 6 (read only when `remotive` is enabled) |
| `DRY_RUN`                   | `true`                  | `true`: print messages, send nothing, mark nothing. Only an explicit `false` sends |
| `TELEGRAM_NOTIFY_DECISIONS` | `top_match,shortlist,review` | Which decisions are notified (`top_match`, `shortlist`, `review`); listing `shortlist` also includes `top_match` |
| `MAX_TELEGRAM_ALERTS_PER_RUN` | `5`                   | Most alerts sent in one run, across all sources (positive integer) |
| `MAX_TELEGRAM_ALERTS_PER_DAY` | `10`                  | Most AUTOMATIC alerts confirmed per calendar day (America/Sao_Paulo), across runs and sources (1 to 1000, else the run fails); manual preview and manual delivery never use it |
| `DISPLAY_CURRENCY`         | `USD`                    | Currency the budget is shown in first, when a fresh stored rate allows it (3-letter code, else the run fails) |
| `AI_ENABLED`                | `false`                 | `true` turns AI analysis on (anything else keeps it off)   |
| `AI_PROVIDER`               | `gemini`                | Only `gemini` exists; no automatic fallback                |
| `AI_MODEL`                  | `gemini-3.6-flash`      | The single model used                                      |
| `GEMINI_API_KEY`            | —                       | Required only for real AI requests (not in dry-run)        |
| `AI_MAX_ANALYSES_PER_RUN`   | `20`                    | Analyses per run, 1-20 (invalid value fails when AI is on) |
| `GEMINI_MIN_INTERVAL_SECONDS` | `15`                  | Minimum seconds between request starts, retries included (AI on only) |
| `GEMINI_MAX_REQUESTS_PER_DAY` | `20`                  | Local daily counter per model, reserved before each call (AI on only) |
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
  index.ts                       Entrypoint: config, wiring, three isolated stages, terminal report
  cli/collect.ts                 npm run collect
  cli/notify-demo.ts             npm run notify:demo
  cli/notify-preview.ts          npm run notify:preview
  cli/notify-manual.ts           npm run notify:manual
  cli/hunter.ts                  npm run hunter (the façade for OpenClaw and the schedule)
  agent/                         Hunter: intents, authorization, lock, schedule, status/hunt/top/more, pipeline runner
  cli/opportunities.ts           npm run opportunities
  cli/telegram-test.ts           npm run telegram:test
  config.ts                      Environment settings with safe defaults
  domain/opportunity.ts          Platform-independent Opportunity model
  domain/filter-result.ts        FilterResult (shortlist | review | skip)
  profile/                       InterestProfile + Don Bruno's interests; CandidateProfile (skills, capabilities, aliases)
  ai/                            Analyzer contract, Gemini client, prompt, output validation, batch runner, quota
  domain/match-analysis.ts       MatchAnalysis, ProposalDraft, actionability (provider-independent)
  filter/opportunity-filter.ts   Deterministic, explainable filter (basic-v3); engagement-policy.ts and location.ts for job sources
  storage/                       SQLite: opportunities, analyses, discovery queue, deliveries, Gemini quota
  pipeline/run-pipeline.ts       list -> save summaries (queue) -> details -> filter -> persist (one source)
  pipeline/collect-sources.ts    runs each enabled source in turn; one failing never stops another
  pipeline/reevaluate.ts         Re-runs the filter on stored rows of older rule versions
  notify/                        Notifier, Telegram client, pt-BR compact presentation, resumable delivery
  sources/opportunity-source.ts  OpportunitySource contract (paged: listRecent(cursor) -> items + nextCursor)
  **/*.test.ts                   Offline tests next to the code they cover (npm test)
  sources/source-errors.ts       Blocked / not-found / unusable-response errors
  sources/99freelas/             First adapter: client (transport), parser (HTML), source
  sources/remotive/              Second adapter: JSON API, safe HTML-to-text, persistent cache and interval
  sources/freelancer/            Third adapter: official API client (token in a header), parser, source with skill-id cache and cooldown
  sources/create-sources.ts      Builds the enabled sources with their own limits
.env.example                     Configuration template (no secrets)
STATUS.md                        Current project state
CLAUDE.md                        Working rules for the implementation agent
```

## Scope notice

V1 implements **one** source first and proves the full pipeline with it before any
other source is added.
