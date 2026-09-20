# STATUS

Last updated: 2026-09-20 (SPEC 000 — Recon + Baseline)

## Real state found

- Git initialized on `main`, **no commits yet**; every file is untracked.
- Present: `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`,
  `src/domain/opportunity.ts`, `src/sources/opportunity-source.ts`.
- Domain model and `OpportunitySource` contract are generic (no platform-specific
  code). `npm run typecheck` passed.
- Inconsistencies found:
  - `src/index.ts` did not exist: `npm run dev` and `npm run start` failed
    (`ERR_MODULE_NOT_FOUND`); `main` pointed to a nonexistent `index.js`.
  - `.gitignore` covered only `data/*.db` (no `.sqlite`, WAL/SHM files, `.env.*`).

## Done

- Added a minimal `src/index.ts` placeholder; `main` now `dist/index.js`.
- `.gitignore` broadened (node_modules, dist, `.env` and variants except
  `.env.example`, SQLite files, logs).
- Created `README.md`, `STATUS.md`, `.env.example`, `CLAUDE.md`.

## Validations run

| Check                  | Result                                   |
| ---------------------- | ---------------------------------------- |
| `npm run typecheck`    | pass (exit 0)                            |
| `npm run build`        | pass (exit 0), emits `dist/`             |
| `npm run start`        | pass, prints placeholder message         |
| `npm run dev`          | pass, prints placeholder message         |
| `git check-ignore`     | `.env`, `node_modules`, `dist`, `*.db`, `*.db-wal`, `*.log` ignored; `.env.example` not ignored |
| `git ls-files`         | empty: `.env` and `node_modules` not tracked |

## Blockers / risks

- No blockers.
- No commit exists yet; the first commit needs authorization.
- `package.json` still has placeholder metadata (`description`, `author`, `license: ISC`).
- `typescript` is `^7.0.2` and `@types/node` is `^26.6.2`; both work today, but
  they are recent major versions worth watching.
- No test runner configured (`npm test` is the npm default stub).

## Next authorized mission

**SPEC 001 — real listing from 99Freelas.** Not started.
