# Job Sniper — Engineering case study

**Category:** Automated opportunity discovery, filtering, enrichment, and notification.

## The problem
Opportunity platforms are noisy, time-sensitive, and often heterogeneous. A useful alert system must not create duplicate notifications, lose work on partial failures, or silently ignore source-specific API constraints.

## Solution and architecture
1. **Adapters:** Keep platform-specific discovery and detail access behind an interface.
2. **Persistence:** Store opportunity summaries and processing state before expensive enrichment.
3. **Deduplication:** Maintain stable source-specific identities in SQLite.
4. **Analysis:** Apply deterministic filters first; optionally use AI under quota controls.
5. **Delivery:** Persist intended notifications, confirm delivery before marking completion, and resume work after interruption.

## Engineering tradeoffs
- Reliability of stages is prioritized over a monolithic all-or-nothing run.
- External rate limits, credentials, and API terms shape the implementation.
- Source-independent models reduce the cost of adding or removing an integration.
- AI analysis is optional rather than a requirement for core pipeline behavior.

## Verification
- `npm run typecheck`
- `npm test`
- `npm run build`
- `.github/workflows/ci.yml` defines automated checks; actual results should be checked in GitHub Actions.

## Publication checklist — complete BEFORE switching to public
- [ ] Audit the entire Git history for credentials, private opportunities, personal contacts, account identifiers, and tokens.
- [ ] Review `STATUS.md`, specifications, agent instructions, and operational documents for private context.
- [ ] Review included third-party platform terms and any source-specific access controls.
- [ ] Confirm there are no local databases, private message samples, logs, or proprietary examples tracked.
- [ ] Ensure onboarding uses `.env.example` and that tokens are never required for static evaluation.
- [ ] Run CI and verify tests are not dependent on production tokens.
- [ ] Separate source-code examples from personal operational configuration.

**Status:** Private pending complete review of repository history and operational materials.
