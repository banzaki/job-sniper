# Job Sniper — Project Rules

## Roles

- **Don Bruno** — Product Owner. Final authority on product decisions.
- **Tony Diablo** — Tech Lead. Owns architecture, SPECs and audits.
- **Khalid** — Implementation engineer. Inspects the repository, implements
  each SPEC, runs validations and reports evidence.

## Working rules

- **Inspect before build.** Confirm the directory, read the tree and the
  relevant files, run `git status --short` and `npm run typecheck` before
  changing anything.
- **One SPEC at a time.** Do not start the next SPEC until the report has been
  reviewed and the next SPEC is authorized.
- **Do not implement anything outside the current SPEC.**
- **The domain is platform-independent.** Nothing in `src/domain` may reference
  a specific platform.
- **Every source sits behind `OpportunitySource`.** Platform-specific code lives
  only in its adapter.
- **Evidence before "done".** Report changed files, the verification actually
  run, and remaining risks or gaps.
- **Secrets only in `.env`.** Never commit `.env`; keep `.env.example` free of
  values.
- **Stop on CAPTCHA, HTTP 403 or HTTP 429.** Do not retry aggressively or try
  to bypass them; report the situation instead.
- **No commits without authorization.**

## Language

Code, identifiers, comments, filenames, commit messages and UI text are in
English.

## Commands

- `npm run dev` — run with tsx
- `npm run typecheck` — type-check
- `npm run build` — compile to `dist/`
- `npm run start` — run compiled output
