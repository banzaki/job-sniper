# STATUS

Last updated: 2026-09-21 (SPEC 007.2 Telegram visual layout implemented and accepted; SPEC 007.1 is d63cda8, SPEC 007 is 22b855a, SPEC 006 is cbd1516. Workana is suspended by its terms of use)

## RECON — Workana and Contra (2026-09-20, read-only; no adapter written, no Gemini, no Telegram)

Method: about 15 spaced requests in total, identified as `JobSniper/0.1 (personal opportunity monitor)`, no login, no cookies
kept, no CAPTCHA or block seen on either site (both sit behind Cloudflare). Nothing was bypassed.

**Workana (`workana.com`) — feasible without login or browser.**
- `robots.txt` allows `/jobs` and `/job/*`; it disallows `/api/` (not used), `*?*ag=1` and login/signup with query.
- **Listing:** `GET /jobs?language=pt&page=N`. The plain HTML has no results (Vue shell); the SAME URL with the headers the site's
  own front-end sends (`Accept: application/json`, `X-Requested-With: XMLHttpRequest`) returns JSON: `results.results[]`,
  `results.pagination` (`page`, `pages` = 100, `total` capped at 10000, `nextPage`, URL template). Fields per item: `slug`,
  `title` (HTML), `description`, `budget` (text band), `isHourly`, `skills[]`, `postedDate` (relative: "há 1 hora"),
  `totalBids`, `country`, `isSearchFeatured`. Only about 9 items per page (nominal limit 20); featured items are pinned on top, so
  order is not strictly by date; pages overlap slightly (1 of 9 seen).
- **Detail:** `GET /job/<slug>`, server-rendered HTML (about 9 KB): title, "Publicado em 20 de Setembro de 2026" (day only), category,
  subcategory, size, duration, skills, status "Aberto", proposals and interested-freelancers counts, description. **No budget in the
  detail** (only in the listing).
- **Stable id:** the slug (a path segment, no numeric id seen). Assumed stable; not verified against title edits.
- **Restrictions:** budgets are in **USD bands** ("USD 100 - 250", "Menos de USD 50", "... / hora"), not BRL; today's client budget
  formatting assumes reais. Proposals need a logged-in account (not needed for monitoring).
- **Terms of use (read afterwards, SPEC 006 preflight): explicit restriction found — Workana integration STOPPED.**
  `https://www.workana.com/terms` redirects to the Spanish "TÉRMINOS Y CONDICIONES DE WORKANA" (help.workana.com). Two clauses apply to
  an automated collector: (1) section "RESTRICCIONES", item (v): users may not "introducir o implementar programas o secuencias de
  comandos con el fin de extraer información, indexar, escudriñar o de otro modo realizar minería de datos en ninguna parte del Sitio de
  Workana" (no scripts or programs to extract information, index, scrape or data-mine any part of the site); (2) community rules:
  users may not "Utilizar un robot, araña web, procesos manuales y/o automáticos o dispositivos para realizar minería de datos,
  rastreos, extraer información o indexar el Sitio de Workana de alguna manera" (no robot, web spider or automatic process to
  crawl or extract information). The terms also forbid copying or downloading any element of the site without prior written consent.
  `robots.txt` allowing `/jobs` does not override these clauses. The RECON requests above (about 15) were made before the terms
  were read; no further request to Workana has been made and none will be until the decision below.
- **Simplest adapter:** plain `fetch` for both calls, JSON for the listing and cheerio for the detail, same shape as the 99Freelas adapter.

**Contra (`contra.com`) — not confirmed feasible; likely needs a session and/or a browser.**
- `robots.txt` allows crawling of public pages (`Content-Signal: ai-train=no`); it does not disallow `/api/`.
- `/opportunities` returns 200 but is a client-rendered app (Relay/GraphQL, `apiUrl: https://contra.com/api/`); the server-rendered
  state holds no opportunity records. The `sitemap.xml` lists only hire pages, users, articles and services: **no opportunity pages
  are public or indexable**. No public detail URL was found, so no stable id, pagination or field list could be confirmed.
- Getting the feed would mean reverse-engineering the site's private GraphQL calls (fragile, and possibly logged-in only) or driving a
  browser with an authenticated session. Step needed from Don to go further: log in himself in a browser and capture, in DevTools
  Network, the request that loads the opportunities feed (URL, method, and whether it works without cookies), WITHOUT sharing
  credentials or tokens in chat. Contra's terms were not read.

**Recommendation (superseded by the terms finding above; technically Workana is the easier source, but its terms forbid the
method):** integrate **Workana first**. It needs no login or browser and has a clear id, pagination and fields. Points to
handle in that SPEC: currency (USD bands) in the budget model and message; the listing budget must reach the stored opportunity
(the `fetchDetail(externalId)` contract only receives the id, so the queue's stored summary or the contract must carry it); relative
listing dates; featured items breaking the newest-first order; reading Workana's terms before enabling a live run.
Rough effort: Workana about one SPEC of the size of the 99Freelas adapter (client, parser, source, fixtures and about 40 offline
tests, plus the small currency and budget-carry changes). Contra: at least two to three times that, dominated by unknowns.

## SPEC 007.2 — Telegram visual layout (implemented and accepted)

Presentation only: ranking, filters, the per-run limit, the database, the sources and deduplication are untouched.
- **Layout (`src/notify/layout.ts`, shared by the basic alerts, Remotive and the AI-analysis messages):** header, classification, title and source
  with recency, facts, `📝 O projeto`, `🤖 Como a IA pode ajudar`, `⚠️ Atenção`, link; blocks separated by blank lines; under 1,000 visible
  characters (fields are tightened in steps, the optional AI-help block is dropped last); HTML-escaped; only safe links.
- **Headers:** `🚨 NOVA OPORTUNIDADE` (real), `🧪 PRÉVIA DE FORMATO` (manual preview only), `🔄 ANÁLISE ATUALIZADA`. A real opportunity never carries preview
  wording (tested). **Classification:** `🟢 BOA OPORTUNIDADE` (shortlist / AI apply), `🟡 VALE REVISAR` (review); the former "VALE CANDIDATAR-SE" is gone.
- **Facts:** budget in the original currency, competition ("N propostas"), fixed/hourly, at most four relevant skills (the filter's strong signals
  only), compatibility in words from the deterministic filter (alta/média/baixa). **Effort and the AI's suggested price only when a saved analysis exists.**
- **Summary (addendum):** `substantiveSummary` skips greetings (Hello, Hi there, Olá, Bom dia, Dear freelancer), labels and numbering (Descrição,
  Project description, Objective), lines under about 30 characters, generic headings and pleasantries; at most two short sentences in the author's
  own words; nothing useful means the block is omitted. Two real bugs were caught by its tests ("Dear Freelancer I need..." lost its first word; a bare
  "Objetivo" label was not removed) and fixed.
- **AI help (`src/notify/ai-help.ts`):** fixed sentences by rules over the title and description only (WordPress, named front-end technologies,
  automation/bots, API/integration, bug fixes, an explicit request to build a site); never claims mastery; omitted when unsafe (skipped project,
  advanced scope, skills only in tags) or without a clear signal. No AI is called.
- **Atenção:** one caveat by priority: restricted access, language, advanced scope, high competition (61+ proposals), then the most relevant
  stored reason. `SOURCE_NOTES`/"Fonte com atraso" no longer exist.
- **Validation:** 452 tests pass (new: summary rules, AI help, headers, blank lines, attention priority, escape); typecheck and build pass. Rendered
  samples of Freelancer.com, 99Freelas (basic and with a saved analysis: new, update, preview) and Remotive from a copy of the real database.
  ONE real preview sent (`freelancer:40724700`, label `visual`, 588 visible characters, with `message_id`); the repeat sent 0; production flags
  unchanged (99Freelas 7 notified, Freelancer.com 5, Remotive 0, analyses 1). No Gemini.

Limits: the two-sentence summary is the author's text as written (it can be in English or German for Freelancer.com); "Compatibilidade" is the
current filter, not an AI score; a real alert of a project that is listed before it was scored by AI carries no effort or price by design.

## SPEC 007.1 — Ranking and alert limit (hotfix; implemented and accepted live)

Everything is still stored; only the best opportunities reach Telegram, without a flood.
- **Limit:** `MAX_TELEGRAM_ALERTS_PER_RUN` (default 5, positive integer), **global per run, across all sources**. Owed alerts are ranked first; what does
  not fit stays pending and is never marked as sent. Stale data (over 24 h for Freelancer.com) is withheld first and uses no slot; a failed
  attempt uses one; dry-run obeys the same limit.
- **Ranking (`src/filter/ranking.ts`):** (1) shortlist before review; (2) crowding tier of a projects marketplace: up to 20 proposals high, 21-60
  normal, 61-150 reduced (sources without proposal counts are normal); (3) most recent publication day (Brasília calendar day, unknown last);
  (4) more strong skills; (5) fewer proposals; (6) stable id `source:id`. The tier sits between decision and recency so "high priority" really
  outranks a newer but crowded project (a reading of the spec's list; recency and strong skills still order everything inside a tier).
- **Filter `basic-v5` (superseded by `basic-v6` below):** a freelance project with **more than 150 proposals** is skipped (stored, never alerted); a project whose language is outside
  the profile languages (`InterestProfile.languages`, now `pt` and `en`) is at most a review. Both apply only to sources that publish an engagement
  type (Freelancer.com, Remotive); 99Freelas has none and is untouched.

- **Filter `basic-v6` (ranking-quality hotfix):** for freelance projects the main task must be technical (title + first 500 characters of the description; payroll, story writing, trading and similar are skipped even with a skill tag, an unclear deliverable is at most a review); a budget range whose top is under US$50 (fixed) or US$8/h (hourly), as an internal USD equivalent, is skipped, one whose bottom reaches the floor passes, and one that crosses it is at most a review; a currency with no published rate is at most a review; 61-150 proposals are at most a review. The parser now keeps the API's `currency.exchange_rate` in `sourceMetadata.exchangeRateToUsd`. AI-help order: bug, API/integration, WordPress, front-end, automation. The Freelancer.com depth is now its own setting, `FREELANCER_MAX_PAGES` (default 5, 1 to 10). **Known limits:** rows collected before this hotfix have no stored rate, so their non-USD budgets are at most a review until the next collection refreshes them; the "technical deliverable" test is vocabulary-based (a bad guess is possible in both directions).

- **Filter `basic-v7` (product correction, supersedes the skips of v5/v6):** `skip` means irrelevant, closed, not technology, forbidden or really incompatible. A low budget (below the US$50 fixed / US$8/h floors, which are now floors for a SHORTLIST), a range crossing the floor, no reliable USD conversion, more than 60 proposals (more than 150 included, with the lowest priority), a very short deadline (24 hours or less) and a transactional scope (payments, checkout) only cap a relevant project at `review`. Ranking: shortlist first; a very crowded review last; then the better budget, fewer proposals, most recent day, more strong skills. The message says "Orçamento baixo para o escopo; avalie se compensa pelo portfólio, avaliação ou experiência." when a low budget is the main caveat. The global alert cap is unchanged. Known limits: the transactional and deadline detection is vocabulary/regex based (it flags many e-commerce projects), and rows collected before v6 still have no stored exchange rate, so their non-USD budgets stay at most a review.

**Validation:** on a copy of the real database, then on the real one: 70 rows re-evaluated, **0 of the 30 99Freelas decisions changed**, 5 Freelancer.com
projects went to skip (239, 274, 240, 384 and 166 proposals). Copy dry run: 5 sent, repeat 5 different ones, overlap 0.
Controlled real run (`SOURCES=freelancer`, one page, AI off): 1 request, 2 new projects, **5 real alerts sent** (12 held by the limit, 0 failures), exactly the five
best in ranking order. The repeat (dry-run, 1 request, 0 new): pending stayed 12, none of the 5 sent came back, and the next 5 would be rendered.
No Gemini; `quota_usage` empty. Sent: 40724784 (5 strong skills, 50 proposals), 40724543, 40724570, 40724652, 40724709.

**Limits:** a few of the top alerts are generic web work with small INR budgets (there is no budget criterion); the tier order can rank a
crowded 5-skill project after a normal 3-skill one; `notify:analyses` is not capped (it is an explicit command). The remaining 12 alerts are owed
and go out 5 per run while their data is under 24 hours old (Freelancer.com), then they are withheld.

## SPEC 007 — Freelancer.com as a project source (implemented and accepted live)

**Status:** official API only (no scraping, no browser, no SDK, no new dependency). Freelancer.com is **off by default**
(`SOURCES=99freelas,freelancer` and `FREELANCER_OAUTH_TOKEN` in the local `.env`; the token is never printed or logged).

- **Endpoints (confirmed live, 5 RECON requests):** `GET https://www.freelancer.com/api/projects/0.1/projects/active/` with `jobs[]` (skill ids),
  `from_time` (Unix, last 7 days), `sort_field=submitdate` (newest first; `reverse_sort=true` returned the OLDEST first), `limit`/`offset`,
  `full_description=true`, `job_details=true`. Skill ids: `GET /api/projects/0.1/jobs/?job_names[]=...`. Detail: `GET /api/projects/0.1/projects/<id>/`
  (the result is the project itself). Auth header `Freelancer-OAuth-V1`. `or_search_query` did not filter and the default order is not by date.
- **Fields used:** id, title, seo_url (page URL `https://www.freelancer.com/projects/<seo_url>`), description, status (`active`), type (`fixed`/`hourly`),
  budget minimum/maximum with `currency.code`, `bid_stats.bid_count`, skills (`jobs` with category), `time_submitted` (Unix = a real instant), language.
  No location is published, so none is invented. Budgets stay in the original currency (USD, INR, EUR, AUD, ...), never converted, and are shown as
  "US$ 250–500" / "INR 12.500–37.500" / "R$ ..."; the client's budget is never called a suggested price.
- **Design:** `freelancer-client.ts` (fetch, token only in a header, errors scrubbed), `freelancer-parser.ts` (normalization), `freelancer-source.ts`
  (skill ids kept 24 h in `source_cache`, listing by page, detail from the listing or a fresh GET, stored cooldown after 401/403/429 of at
  least 6 h or Retry-After). No schema change (still v4). `SourceAuthError` for 401 ("the token may have expired; it lasts 30 days").
- **Selection V1:** freelance technology projects with a defined deliverable. The engagement policy now also applies to Freelancer.com (all
  its projects are `freelance`): a non-technology category, a continuing-team wording ("long term", "join our team") and a closed project are stored
  but not alerted; a senior title is at most review; **a strong skill that appears only in the skill tags (never in the title or description) is at most
  review** (added after the first real run shortlisted 16 of 20 because of generic tags such as HTML on translation and support jobs). Rule
  version `basic-v4`; on a copy of the real database all 49 stored decisions were unchanged (0 of 29 99Freelas rows).
- **24-hour data rule (API terms):** alerts are sent only from data collected within 24 h; an older unsent opportunity is withheld, reported
  (`withheld (data too old)`) and never marked as delivered. Identity, decision and delivery history stay for deduplication. Status is
  confirmed at collection time only.
- **Telegram:** one compact message: classification, title, source, "🆕 Publicada hoje / há X dias" (calendar days in Brasília time, up to 7
  days), budget with currency, fixed or hourly, proposals, up to four skills, one-sentence summary, main caveat, original link.
- **Recency (also Remotive):** real instants are compared by calendar day in Brasília time; a zone-less date only by its day.

**Live acceptance (2026-09-21, no Gemini):**
- Requests to Freelancer.com: RECON 5, first collection 2 (skill ids + 20 projects), one detail check 2, repeat collection 1 = 10.
- First collection: received 20, normalized 20, new 20, known 0, failures 0. Under the first rules: shortlist 16, review 2, skip 2; after the
  tags-only rule and re-evaluation: **shortlist 9, review 9, skip 2**. Currencies: INR 10 (6 fixed, 4 hourly), USD 7 (4 fixed, 3 hourly), EUR 3; all
  status open. No project was alerted (18 non-skip are pending; see the risk below).
- Repeat: 20 known, 0 new, 0 details; the database holds 20 rows and 20 distinct ids for Freelancer.com; the same id under another source is a
  different opportunity (tested); Remotive and 99Freelas untouched (99Freelas re-checked live: 10 summaries, 1 detail, 2 requests).
- Telegram: dry-run of three projects, then ONE real preview of `freelancer:40724700` (354 visible characters, with `message_id`, identified
  "PRÉVIA"); the repeat sent 0. Production flags untouched; `quota_usage` empty; Gemini not called.

**Known limits / risks:**
- ~~A first run would send all pending alerts at once~~ fixed by SPEC 007.1: 5 alerts per run, best first.
- The skill filter is text based: many matches are generic web work with hundreds of proposals and small budgets in INR/USD; the profile has no
  budget or competition criterion yet.
- The Personal Access Token lasts 30 days; renewal is manual (see the README).
- Personal use only. A multi-user or sold service needs its own OAuth application per user (or Freelancer.com's written permission) and a new review
  of the terms; not implemented.
- Status is confirmed only at collection time; a project can close before the alert.

## SPEC 006 — Remotive as the second source (implemented; awaiting review)

**Status:** code, offline tests and the limited live acceptance are done. **Not committed**; the working tree is on top of 58f8831.

- **Adapter** (`src/sources/remotive/`): `RemotiveSource` over plain `fetch` and the documented API
  `remotive.com/api/remote-jobs?category=software-dev`; no browser, no page scraping. One response holds every job with its
  description, so each "detail" is read from the stored response (no request per job).
- **Identity:** the API `id` (as text), under `sourceId = remotive`. Ids are unique per source everywhere (opportunities, queue,
  deliveries). Kept as published: original Remotive URL (only https remotive.com is accepted), title, company, category, tags,
  hiring type, required location, pay text, publication date. HTML becomes plain text without rendering (scripts, styles, handlers,
  links, iframes dropped; entities decoded; bounded). Absent fields stay unknown; the pay is never converted, never a budget.
  A publication time without a time zone is **not** turned into an instant (publishedAt stays null, the raw text is kept).
  Status: "open" because the API lists the job as live at download time (feed delayed 24 h; applications not verified);
  access is unknown.
- **Generic changes (minimal):** `Opportunity` gained optional `employmentType`, `locationRequirement`, `compensation`
  (undefined for 99Freelas); `SourceBlockedError` carries `retryAfterSeconds`; the queue is listed per source; `SOURCES` and
  `REMOTIVE_MIN_INTERVAL_HOURS` in the config; `collectSources` runs each source with its own limits and isolates failures;
  automatic AI selection is limited to `AI_SOURCE_IDS = ['99freelas']` (the analysis prompt, BRL price and proposal do not fit a
  job feed; `--only` still works).
- **Cache and frequency:** schema **v4** adds `source_cache` (last response, last attempt, next allowed time). At least 6 hours
  between queries, counted from the attempt (recorded before the request), failures included; a failure serves the older
  response and is not repeated in sequence; 429/403 waits max(interval, Retry-After). Restart-safe.
- **Scope of version 1 (review decision):** freelance technology projects with a defined deliverable. Remotive stays **disabled by
  default** (`SOURCES` defaults to 99freelas). A jobs mode is a later step and was not started.
- **Filter `basic-v3`:** engagement policy for job sources (only lowers a result): full time, part time, internship and **contract**
  -> skip (stored, never alerted; a contract says nothing about a defined project); a category that is clearly not technology
  (Writing, Design, Marketing, Sales, Customer Service, ...) -> **skip** even with a skill word in the text; freelance that reads like
  a continuing team role ("join our team", "long term", "ongoing", "integrar a equipe") -> skip; missing/unknown type -> at most review,
  never shown as freelance; a location naming only other places -> skip; "Remote" alone, time zones, "Worldwide except", missing or
  restricted in the description -> at most review; senior title -> at most review; Brazil, LATAM, South America, Americas,
  worldwide -> compatible.
- **Telegram:** one compact message (at most 1,000 characters) from collected data only: classification, title, source and company,
  type, required location, pay as published, one-sentence summary, main caveat and the original link. No
  score, suggested price or proposal. The 24 h delay of the feed is documented here and in the README, not repeated in each alert.
  Recency: "🆕 Publicada há X dias" only for a reliable date at most 7 days old (calendar days; the API date has no time zone, so
  only its day is used and no time of day is shown); older or unknown dates get no highlight. `notify:demo` previews an opportunity without analysis with its basic message.

**Live acceptance (2026-09-21, no Gemini):**
- Migration validated on a copy first, then applied to the real database by the first command (automatic backup
  `data/job-sniper.pre-v4.db`). On the copy: only `source_cache` was added; 0 of the 29 99Freelas rows changed decision, reasons,
  keywords, `notified_at` or `first_seen_at` under `basic-v3` (only the rule version label changes).
- **One** query: HTTP 1 request, 20 jobs (the API itself reports `total-job-count: 20`; the `category` parameter did not restrict
  it: Writing, Design, Customer Service and others came back). By type: full_time 12, freelance 4, contract 3, part_time 1.
  Decisions under the first rules: skip 16, review 4 (three "Senior" contract jobs and a freelance copywriter), shortlist 0. After
  the review adjustments (contract, non-technology category and team roles skipped) the 20 stored rows were re-evaluated:
  **skip 20, review 0, shortlist 0** (3 contract, 12 full time, 1 part time, and 4 freelance: a copywriter in Writing plus three
  that were already skipped by the skill or location rules). Nothing is pending to notify from Remotive. No relevant
  opportunity in this sample; the filters were not weakened to produce one.
- Second run: 0 requests (cache), 20 already known, 0 new, 0 details, 0 duplicates (20 rows, 20 distinct ids).
- Telegram: dry-run preview, then one real preview of `remotive:2091140` (400 visible characters, with `message_id`, identified
  "PRÉVIA"); the repeat sent 0. Production flags untouched (99Freelas 7 notified, Remotive 0, analyses 1); `quota_usage` empty.

**Known limits / risks:**
- There is no per-run cap on basic notifications. With the V1 rules a first run of a fresh feed is unlikely to be large, but a burst is possible.
- The team-role wording rule ("ongoing", "long term", "join our team") is deliberately blunt: a project that says "ongoing support" is skipped too.
- The public API returned only 20 jobs in total and ignored the category; coverage is small and mixed, so most of it is skipped.
- Location and seniority are text rules (a listed country set, title words); wording outside them becomes review, never shortlist.
- A job that drops out of the feed before its detail is read becomes `unavailable` after two not-found answers (local reads).
- Remotive's terms allow personal use with attribution; a public or sold service would need its permission (it sells a private API).
- AI analysis for jobs (contract or salary roles) is not written; Remotive items get no score, price or proposal.

## RECON — official channels and alternative sources (2026-09-20, documentation only; no job collection, nobody contacted)

Method: web search plus reading public documentation and terms pages. No vacancy was fetched, nothing was implemented, no dependency added.
Personal use here means alerts for Don Bruno's own Telegram; a service sold to others is a different case and is called out per source.

**Workana — no official API, feed or partner program found.** The only official channel is email notification of new projects
(help center article "How do I configure project notifications received by email", `help.workana.com`); a community post says it is
Premium-only (unofficial, not verified). Email parsing would be a different integration; not evaluated further.

**Contra — no official job feed found.** Third-party listings (API Evangelist, apis.io) describe a read-only "Public API" under
`contra.com/public-api/` with an `X-API-Key` header covering programs, filters and expert profiles, not job listings; the URL returned
404 when opened, so this is **unverified**. The help center only mentions the in-app "Job feed". Correction to the earlier RECON: Contra also
has public SEO pages such as `contra.com/featured-jobs/freelance-coding-jobs`; they were not opened and their origin (Contra clients or
aggregated) is unknown, and their terms were not read.

**Candidates (up to three), most relevant first**
1. **Freelancer.com official API** (freelance projects; best fit). Docs `developers.freelancer.com`; terms `freelancer.com/about/apiterms`.
   Access: own account, "Get API Key" at `freelancer.com/developers`, accept the terms, OAuth2 token (header `freelancer-oauth-v1`);
   sandbox at `freelancer-sandbox.com`. Project search and details exist (`/api/projects/0.1/projects...`); fields reported by the
   official SDK: id, title, seo_url, description, budget min/max, currency, time_submitted, status, type (fixed/hourly/local/hireme),
   bid_stats, jobs (skills). I could not read the endpoint reference page itself (docs are script-rendered), so filters and rate-limit
   numbers are **unconfirmed**. Terms (read): personal and internal use allowed; you "may not sell, rent, lease, sublicense,
   redistribute, or syndicate access to the API"; charging for an application is allowed; "will not rely on the functioning ... of the
   API in the conduct of your ordinary course business"; "may not use the API to replicate or compete with the services offered by
   Freelancer"; cached data must be refreshed at least every 24 hours, stored with strong encryption, and deleted on termination;
   no circumventing rate limits. Fit for personal use, with **one design conflict**: our database keeps opportunities indefinitely,
   which the 24-hour cache rule may not allow; a retention decision (or written clarification from Freelancer, requested by Don) is needed.
   A sold service would need explicit permission; the terms do not allow sharing API access with customers.
2. **Hacker News, official Firebase API** (`github.com/HackerNews/API`, base `hacker-news.firebaseio.com/v0/`). No key, no documented
   rate limit; the monthly "Freelancer? Seeking freelancer?" thread is a story item whose `kids` are the posts. Real freelance and
   one-off work, but low volume, free-text posts (no budget or currency fields; text would need extraction) and a mix of people offering
   work and people seeking it. The repository is MIT-licensed; that does not by itself grant rights over the posts, and no data terms were found.
   Easiest to integrate technically, weakest in structure and volume.
3. **Remotive public API** (`remotive.com/api/remote-jobs`, docs `github.com/remotive-com/remote-jobs-api`). No key. Fields: id, url, title,
   company_name, category, job_type (includes freelance and contract), publication_date, candidate_required_location, salary,
   description (HTML). Rules: at most about 4 fetches per day, above 2 per minute is blocked, listings delayed 24 hours, and you must
   link back and cite Remotive; violations end access. **Mostly employment**, not project work. Personal use fits; redistribution
   or a sold service would need Remotive's permission. Remote OK (`remoteok.com/api`) is similar (attribution and link-back required,
   USD salary range, ISO dates) and also mostly jobs.

**Not usable now:** Upwork has an official GraphQL API (`api.upwork.com/graphql`, OAuth2, approved credentials, marketplace job
postings permission), but its developer and legal pages returned HTTP 403 to our fetch, so its terms are **unread**; secondary
sources say scraping and automation outside the API are against its terms. Not bypassed; needs Don to read the API terms and request credentials.

**Recommendation:** Freelancer.com first, as the only candidate that is an official API for freelance projects with budget and
currency fields, and personal use is allowed by its terms. Before any SPEC: Don creates the developer account and API key himself (never in
chat) and decides, with the Tech Lead, how to handle the 24-hour cache rule. Effort estimate: one adapter SPEC smaller than the
99Freelas one (JSON API, no HTML parsing), plus the generic multi-source and currency work already outlined for Workana. Hacker News
is the fallback if a no-key, quick proof of the multi-source path is wanted.

## SPEC 005 — Readable Telegram, persistent queue, quota control (approved; committed 58f8831)

**Status:** approved by the Tech Lead and committed as `58f8831`. The SPEC 004 checkpoint is `4aa3f07`
("feat: add AI opportunity analysis and proposal drafts"). Former partial multi-part deliveries stay *held*: explicit state
in the report, no automatic re-send, unsent parts never marked as delivered.

- **Telegram (pt-BR), compact format (Tech Lead decision, replaces the summary + details format):** ONE message per
  opportunity, aiming at 600-900 visible characters with a ceiling of 1000: classification and title, platform, one
  sentence about the work, AI suggested price kept apart from the client's budget, estimated effort, the main caveat,
  availability (an estimated release time is never stated as confirmed) and the link. No proposal, skill lists, internal
  explanations, second automatic message or "details in the next messages". The full analysis and the proposal draft stay
  in the database and are read with `npm run analyses` (`--details`, `--proposals`, `--messages`). No AI call to format,
  no interactive buttons. Delivery keeps its controls: stored before sending, `message_id` on confirmation, flags only
  after confirmation, dry-run writes nothing, presentation changes never re-send history. `npm run notify:demo` sends
  one identified preview of a saved analysis.
- **Deliveries in the former multi-part format** (reference without the `#c1` marker) are **not resumed and not re-sent**;
  their unsent parts are never marked as delivered. If at least one part had reached the owner the analysis is *held*
  (not announced again, flags untouched); if nothing had reached the owner it is delivered in the compact format. Both
  cases are listed in the notification report. The real database has none (only two completed demo deliveries).
- **Persistent queue (`discovery_queue`):** summaries saved before details; known ≠ details obtained; survives restarts;
  temporary failures back off (15 min doubling to 24 h); `unavailable` only after a definitive not-found twice.
  Independent limits: 20 pages, 100 new summaries, 20 details; the detail budget is split between older pending and new.
  `DISCOVERY_TARGET_NEW` now counts new summaries.
- **AI selection:** shortlist/review first; basic-skip kept aside unless `--only`; never-attempted before failed; at most 3
  attempts per failed opportunity; skill aliases without confirming anything; no mass invalidation of successes.
- **Gemini quota:** 15 s between request starts (retries included); persisted daily counter per model (default 20)
  reserved before each call; day rollover in America/Los_Angeles; lock with crash recovery; `Retry-After` and quota
  detail parsing; persisted cooldown on 429; an AI pause never blocks delivering saved analyses.
- **Schema v3** (`PRAGMA user_version = 3`): adds `discovery_queue`, `deliveries`, `delivery_parts`, `quota_usage`,
  `quota_state`, `run_locks`. Validated on a copy first, then applied to the real database with an automatic backup
  (`data/job-sniper.pre-v3.db`, git-ignored). After the migration: opportunities, analyses and proposal drafts are
  byte-identical to the backup (27 / 14 / 11 rows).

**Live acceptance (2026-09-20, no Gemini call, `quota_usage` stayed empty):**
- First demo (former two-part format, superseded): 2 parts sent, repeat sent 0.
- Compact preview of `99freelas:785772` (after the format decision): dry-run rendered 1 message and wrote nothing; the real run
  sent 1 message (576 visible characters, with `message_id`); the repeat of the same command sent 0. Real notification
  flags unchanged (7 and 1); `quota_usage` stayed empty.
- Real discovery limited to 3 pages and 2 details: 30 summaries = 0 known + 30 new + 0 queued; 2 details attempted =
  2 obtained + 0 failed + 0 unavailable; queue afterwards: 28 pending, 2 done; stop reason `max-pages-reached`; 5 HTTP requests.
- Quota controls were validated with a **simulated** clock and provider (18 tests): pacing, retry counted, daily limit across
  restarts and LA rollover, shared counter, 429 parsing, cooldown across restarts, lock and crash recovery. No real Gemini
  call was made in the SPEC 005 mission.

**Known limits / risks:**
- Telegram delivery is at-least-once in one rare case: if a message is accepted but the confirmation is lost, that part
  is recorded as *ambiguous*, reported and retried next run, so it can appear twice. It is never dropped silently.
- The daily Gemini counter only knows requests made since this version; earlier usage is invisible to it.
- 28 discovered opportunities are still pending details; they are worked off by later runs, 20 details per run.
- The one-sentence description comes from the opportunity text (first sentence, list numbers and heading words removed);
  the real preview came out at 576 characters, a little under the 600 aim, because that sentence is short.
- Not started: dashboard, scheduler, second source, payment, automatic application.

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
- Not started: dashboard, scheduler, second source, automatic application (auto-apply), login automation, Playwright.

## SPEC 004 — AI analysis + assisted proposal (implemented, committed `4aa3f07`; real Gemini and Telegram acceptance succeeded)

**Status:** code, migration and offline validation are complete, and the acceptance with the real Gemini and the real
Telegram succeeded (analyses were produced and the saved analysis of 99freelas:785772 was delivered to the owner's Telegram).
The sections below keep the history, including the intermediate problems that were fixed along the way.

**Architecture** (`src/ai/`): provider-independent `OpportunityAnalyzer { id, model, analyze(input) }`;
`GeminiAnalyzer` over plain `fetch` (key in the `x-goog-api-key` header, one model, no tools/grounding,
no fallback); `prompt.ts`; `analysis-output.ts` (strict JSON validation, truthfulness guard, skill
reconciliation, access rules); `analysis-batch.ts` (newest first, ≤ 20, sequential, partial progress kept).
Domain: `MatchAnalysis` and `ProposalDraft` (`src/domain/match-analysis.ts`). New `CandidateProfile`
(`src/profile/`): the SPEC assumed one existed, but only the interest profile did, so it was created.

**Schema v2** (migration is `CREATE … IF NOT EXISTS`, idempotent, never touches opportunity rows; a copy
`data/job-sniper.pre-v2.db` is made once before the first upgrade of a v1 file):
`analyses` (PK `source_id, external_id, analysis_version`; `status success|failed`; provider, model, score,
confidence, `recommendation` (final) and `model_recommendation`, `result_json`, `error_message` (trimmed,
secret-free), `attempts`, `notified_at`) and `proposal_drafts` (same PK; `language`, `body`, `status
draft|approved|submitted|discarded`). Pending = open opportunities with no success for the version;
failed rows stay pending. A forced re-analysis replaces the result but keeps `notified_at`.

**Prompt and schema decisions:** `ANALYSIS_VERSION = ai-v1` (bump to re-analyze). The model returns score,
confidence, `apply|review|skip` (never `wait`), fit, matched/missing skills, risks, client questions, effort
range, complexity, BRL price range + rationale, proposal language and text. Opportunity text is one JSON
document declared untrusted; the URL and the access restriction are deliberately not sent (restrictions must
not influence the technical score). Strict on required fields, enums and numeric ranges; lenient only in
trimming empty list items and shortening long explanatory text. The proposal is checked locally and rejected
if it claims mastery, certifications, years of experience, past clients/portfolio (while no experience is
recorded), mentions an unavailable skill, or contains a link, e-mail, phone, messaging app or off-platform
payment. Matched skills outside confirmed/learning skills are moved to missing.

**Premium / exclusive handling:** `Opportunity.access { kind public|premium_only|unknown, publicAt, rawLabel }`
(ISO strings, like the rest of the domain). 99Freelas: the "Projeto Exclusivo" flag → `premium_only`; its
title text is kept verbatim (also in `sourceMetadata.exclusiveLabel`); `publicAt = fetchedAt + countdown`
only when "…disponível para todos os profissionais em 23h52m30s" parses unambiguously (else null, never
guessed). No flag → `public`. **Caveat:** the anonymous page never says "Premium" or mentions invitation
points; `premium_only` is inferred from "exclusive, available to everyone later". The candidate's 99Freelas
account is recorded as free, so a compatible restricted opportunity becomes `wait` (score untouched); `review`
and `skip` are left as the model said. Rows stored before this SPEC read back as `unknown` access.

**Notifications:** independent `analyses.notified_at`. Enriched (first message + AI), AI update (opportunity
already notified or filtered by basic-v2), basic (no analysis). A clear AI `skip` is neither announced nor does
it release the basic message. Headers `🟢 APPLY`, `🟡 REVIEW`, `🕒 WAIT — PREMIUM ONLY`, `🔴 SKIP`.

**Commands:** `npm run ai:analyze` (`-- --limit N`, `-- --only <sourceId:externalId>`, `-- --force`),
`npm run analyses` (`-- --proposals`, `-- --messages`, read-only). Neither contacts 99Freelas. With
`AI_ENABLED` off they are valid no-ops; with `DRY_RUN=true` they only list what would be analyzed.

**Validation done (no Gemini contacted):**
- `npm test`: 164 tests, all pass (was 40). New coverage: valid analysis; invalid JSON; score out of range;
  each missing field; timeout; 429; one bounded retry; no fallback (single model URL, no tools); 20-item batch
  limit; partial progress after quota; failures stay pending; same version not repeated; new version eligible;
  cancelled/closed skipped; premium+free → wait; public stays apply; uncertain countdown → no `publicAt`;
  proposal truthfulness; prompt injection; notification deduplication; migration preserving rows and
  `notified_at`. Mutation check: breaking the `wait` rule, the analysis notification mark and the open-status
  filter made 6 tests fail; reverted.
- Fake-provider run on a **copy** of the real database: v1→v2, 27 rows and 7 `notified_at` identical, backup
  made, batch of 20 (eligible 27, 7 left pending), 2 apply / 18 skip from the fake, 2 AI updates rendered,
  `notified_at` untouched by the dry-run.
- Real database migrated by `npm run analyses`: `user_version` 1 → 2, all 27 opportunity rows identical to the
  backup column by column (payload included), 7 `notified_at` preserved, `analyses`/`proposal_drafts` empty.

**Live acceptance attempt (Tech Lead audit):** `npm run ai:analyze -- --only 99freelas:785772` with
`AI_MODEL=gemini-3.8-flash` (set for that command only; the code default is still `gemini-3.6-flash`).
Two runs, each 2 HTTP requests (the request and its single bounded retry): every response was
**HTTP 503, "This model is currently experiencing high demand"**. Only a 503 was observed, with no explicit
authentication error; that is **not** evidence that the key or the integration work (correction of an earlier
note that wrongly said the key was accepted). Nothing was persisted as a success; one `failed` row exists (`attempts=2`, provider gemini,
model gemini-3.8-flash, trimmed secret-free message, no score, no proposal) and the opportunity stays
pending. No model fallback was attempted, as designed. The default model is therefore unchanged.
`AnalyzerStats` (request count and last HTTP status, no headers) was added to print this evidence.

**Live acceptance with `gemini-3.6-flash` (explicitly authorized, model set for that command only): SUCCESS.**
`npm run ai:analyze -- --only 99freelas:785772`: 1 HTTP request, status 200, provider gemini, model and
reported modelVersion `gemini-3.6-flash`. Result: `apply`, 95/100, confidence high, effort 15-25 h, medium
complexity, R$ 800-1500, proposal draft in pt-BR (683 chars). The local validation passed (0 truthfulness
violations; ranges valid; matched skills all in the profile). Persisted: 1 `analyses` row (`success`,
`attempts=3`, counting the earlier failed attempts) and 1 `proposal_drafts` row (`draft`); the earlier
`failed` row was replaced by the success. A failed analysis stays eligible (it was: status failed,
recommendation null, position 1 of 27) and a provider error never becomes `skip`. Re-running the same
command without `--force`: eligible 0, **0 requests to Gemini**, no new rows.

**This result is PROVISIONAL.** The candidate profile is still provisional: the 11 "confirmed" skills come
only from the interest list approved for SPEC 002 (interest is not competence) and were labeled "confirmed"
by the implementer, not by Don Bruno. Do not use the generated proposal until Don reviews
`src/profile/bruno-candidate.ts`. Observation: the draft says "Garantirei um carregamento rápido…"
(a guarantee); the local guard does not catch promise verbs and could be extended.

**Adjustments after the acceptance (Tech Lead request, `gemini-3.6-flash` kept):**
1. **Profile:** the 11 skills inferred only from interests are now `unverified` (interest kept via `interest: true`
   and an `evidence` note), no longer "confirmed". They were NOT turned into `unavailable`. React stays `learning`.
   No skill is `confirmed` until Don Bruno says so.
2. **Analyzer:** interest, confirmed and unverified are separate. The prompt has `confirmedSkills`,
   `unverifiedSkills`, `learningSkills` and `unavailableSkills`. Locally, `apply` is only kept when at least one
   skill matched and every matched skill is confirmed; otherwise it becomes `review`, the raw model
   recommendation is kept in `modelRecommendation`, `verification` names the unverified skills, and the note is
   the first risk. `wait` now requires a verified match. The score is documented and shown as a technical-fit
   rating, "not a success probability".
3. **Versioning:** the effective analysis version is now the prompt version plus a profile fingerprint
   (`ai-v2+p<8 hex>`; currently `ai-v2+p5319dcd3`). A relevant profile change (skill or level, scope note,
   interest flag, recorded experience, account capability) re-opens every stored opportunity even with the same
   prompt; evidence wording and ordering do not. Earlier analyses stay as history under their old version. Drafts
   from older versions are set to `discarded` (text kept; approved/submitted untouched), on every `dev`,
   `ai:analyze` and `analyses` run. The analysis and proposal made for 99freelas:785772 under the earlier profile
   were invalidated this way (the row `ai-v1` is history; the draft is `discarded`).
4. **Access:** new `npm run access:refresh -- --id <sourceId:externalId>` re-reads one detail page (1 request) and
   updates only `access` (+ `sourceMetadata.accessCheckedAt`). A passed `publicAt` never makes an opportunity
   public: it becomes access status `unknown` ("verify availability"), and messages say "Verify availability
   before applying". For 785772 the fresh read still shows "Projeto Exclusivo … em 19h27m25s": `premium_only`,
   `publicAt` 2026-09-21T19:37:02Z (estimate), checked 2026-09-21T00:09Z.
5. **Prompt and guard:** no absolute guarantees of performance or outcomes; performance depends on hosting, media,
   third-party scripts and how it is measured, so the model should name what must be defined. The local guard now
   also rejects guarantees ("garanto", "garantirei", "prometo", "100%", "sem erros/falhas", "com certeza") and
   first-person competence assertions ("tenho experiência", "domino", "sou proficiente").

Validation: 205 tests pass (was 165), typecheck and build pass. Mutation check (removing the review cap, the
guarantee guard, the passed-time rule and the profile level in the fingerprint) made 15 tests fail; reverted.
The `gemini-3.6-flash` result for 785772 above is superseded: it must be redone after the profile is reviewed.

**Acceptance round (declared profile, `gemini-3.6-flash`, analysis version `ai-v3+pfc05c365`):**
- **Profile:** Don's declared context is recorded (`declaredContext`: beginner working with guidance and AI; took
  part in configuring and validating Job Sniper; has not yet published a complete landing page; competences not
  confirmed by inference). Levels unchanged (no skill confirmed). It is part of the fingerprint and is not
  citable experience.
- **`apply`→`review` rule found incomplete and fixed.** Before: only the skills the model listed as *matched* were
  checked, so one confirmed skill released `apply` even with an essential skill unverified, omitted or outside the
  profile (demonstrated: 3 of 4 cases released `apply`). Now the model must list `essentialSkills` and `apply`
  stands only if there is at least one and ALL are confirmed; unverified, learning, unavailable or absent essential
  skills block it, are shown in `verification`, and confidence is capped at `medium`. Prompt version `ai-v3`.
- **785772 re-analyzed:** `review`, 55/100, confidence low; essential skills unverified/not covered stated in the
  fit text, risks and verification; premium access kept separate (actionability `restricted`, opening estimated
  2026-09-21T19:37Z; the proposal does not mention it and the score/recommendation were not driven by it);
  proposal 728 chars, no invented experience, no guarantee verbs, no links/contacts (guard: 0 violations).
- **Batch:** the same run stopped by quota. 10 successes (785772 review; 785771, 785770, 785768, 785766, 785761,
  785758, 785757, 785755, 785754 skip), 3 failures (785765, 785762, 785760: the local guard rejected the proposal),
  17 still pending, stop reason `quota-exhausted` (HTTP 429; no retry, no other model). Note: `.env` had
  `AI_MAX_ANALYSES_PER_RUN=1`, which capped one `--limit 19` run to a single analysis; the later run set it to 20
  for that command only. `.env` also has `AI_MODEL=gemini-3.8-flash`, overridden per command.
- **Repeat over the same 10 IDs:** 0 requests to Gemini for each, no new rows; database: 10 success + 3 failed, no
  duplicate (id, version), old `ai-v1` result kept as history with its draft `discarded`.
- **Telegram:** the one eligible analysis (785772, `review`) was NOT sent. Every call to the Bot API returned
  HTTP 404 "Not Found" (also `telegram:test`), which points to an invalid or revoked token in `.env`. Nothing was
  marked as notified; the message was rendered in dry-run instead. Duplicate notifications: none possible so far.
- **Guard false positives suspected:** 3 of 11 proposals were rejected for "link/e-mail/phone" and/or "mastery".
  The phone pattern may match numeric price ranges such as "800 - 1.500"; the stored failure text does not keep the
  proposal, so this is a hypothesis to check before the next batch.
- New: `npm run notify:analyses -- --only <ids>` announces only the AI analyses of the given opportunities.

**Follow-up (delivery of the persisted analysis, no Gemini calls):**
- Effective configuration (loaded by the program, nothing preset in the shell): model `gemini-3.6-flash`, limit 20,
  `DRY_RUN=false` (real sending), Telegram token and chat id present.
- Telegram: `getMe` with the value in `.env` returned HTTP 404. Diagnosis by structure only (no values printed):
  the `TELEGRAM_BOT_TOKEN` value has 57 characters and 3 colon-separated parts: a stray 10-digit prefix
  (not the chat id) followed by the real `<bot id>:<secret>`. In memory, `getMe` with the last two parts returned
  HTTP 200, ok, bot `DonBrunoJobSniperBot`. Configuration loading is correct; the value in `.env`
  must lose the leading `<10 digits>:`. Sending was stopped; nothing was sent or marked; `.env` was not touched.
  The program now validates the token format (`requireTelegramCredentials`) and fails fast with an error that
  reports only the number of colon parts and the length, never the value.
- Guard false positives were reproduced offline: `R$ 800 - 1.500` and `2026-09-21` were blocked as "phone".
  Fixed narrowly: amounts in reais and dates are blanked before phone detection, and phones are detected by real
  formats (+country, (area) number, area + number, 0800, 10-13 digit runs, local xxxx-xxxx). All 8 phone formats,
  links, e-mail, messaging apps and off-platform payment stay blocked, and a phone cannot hide inside an amount or
  date (a test caught and led to fixing one such bypass). 247 tests pass.

**Resolved afterwards:** the token was corrected in `.env` and the saved analysis was delivered (historical note; the
message format has since changed, see SPEC 005). **Still open:** retry of the pending and failed analyses after the quota
resets (the failures were produced under the old guard) and the owner's confirmation of the candidate skill levels.
No application was made.

**Skill levels need the owner's confirmation:** `src/profile/bruno-candidate.ts` derives confirmed/learning/
unavailable skills from the approved interest profile (React = learning/basic; native mobile, private AI,
DevOps, blockchain, telephony… = unavailable). No experience, clients, years or certifications are recorded,
so none may be claimed. Proposals are only as truthful as this file.

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

1. ~~Deferred items are not persisted.~~ Resolved by SPEC 005 (persistent discovery queue).
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
- Deferred items are now stored in the discovery queue (SPEC 005) and no longer depend on the scanned pages.
- Pages shift while a run is in progress; overlap is deduplicated, but an item moving from a not yet
  scanned page to an already scanned one can be missed until a later run.
- No `closed` status code observed; only "Aberto" budgets interpreted; `node:sqlite` is experimental.
- Offline tests cover discovery, adapter pagination and configuration; the filter, Telegram client and
  message formatting were verified by ad hoc scripts (not in the repository).
- Telegram messages are in Portuguese (the only UI-text exception, SPEC 005); everything else stays in English.

## Blockers / risks

- SPEC 003 is closed (`b0495bc`); SPEC 003.1 is approved and committed (`157df4c`).
- SPEC 004 is committed (`4aa3f07`) and its real Gemini and Telegram acceptance succeeded. The SPEC 005 quota controls
  have only been exercised with a simulation; the first real use will be the next real AI run.
- AI limits to keep in mind: free-tier quotas are set by Google and can change; a 429 ends the run's batch.
  The proposal guard is intentionally blunt and may reject a harmless proposal (it is retried next run).
- `data/job-sniper.db` holds real data from the live site (git-ignored).
- **Secret hygiene:** at closing time the working copy of `.env.example` (a tracked file) contained
  a bot token-like value. It was never committed (history and HEAD checked); the SPEC 003 commit
  contains a sanitized `.env.example`. The token must live only in `.env`. Because it was written
  to a tracked file and appeared in a tool result of this session, consider revoking and
  regenerating it with @BotFather (`/revoke`) and updating `.env`.

## Next authorized mission

**SPEC 007 (Freelancer.com)** implemented and accepted live. Remotive (006) and Freelancer.com (007) are optional sources, off by default. Workana stays
suspended by its terms of use. Nothing further (Contra, dashboard, scheduler, auto-apply, interactive buttons, a jobs mode) has been started.
