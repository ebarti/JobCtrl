# Phase 14 Verification: Jobs Drawer Audit Triage

**Date:** 2026-06-11
**Status:** Passed

## Commands

| Command | Result |
|---------|--------|
| `corepack pnpm web:check` | Pass |
| `corepack pnpm --filter @jobhunter/web test src/views/jobs/JobDetailDrawer.test.tsx src/views/jobs/JobOverview.test.tsx` | Pass, 2 files / 7 tests |
| `corepack pnpm web:build` | Pass, with existing Vite large-chunk warning |
| `git diff --check` | Pass |

## Browser QA

QA used a paired current-checkout API and web server:

- API: `JOBHUNTER_API_PORT=8876 corepack pnpm --filter @jobhunter/api start`
- Web: `VITE_DEV_API_PROXY_TARGET=http://127.0.0.1:8876 corepack pnpm --dir apps/web exec vite --host 127.0.0.1 --port 5277`

Verified product path:

1. Opened `/jobs` with the current web server and current API proxy.
2. Activated the visible Jobs table Open control for a row.
3. Confirmed the drawer route opened.
4. Confirmed `.job-audit-triage` was present.
5. Confirmed the triage title was `Why this job is here`.
6. Confirmed ranking metrics rendered fit score, fit band, confidence, and eligibility status.
7. Confirmed readiness facts rendered missing prerequisites, eligibility concerns, and inspectable source facts from `applyAudit`.
8. Confirmed the handoff link target was `/apply-review`.

Safety boundaries:

- Did not run auto-apply.
- Did not trigger browser submission.
- Did not scan mailboxes.
- Did not generate or replace materials.
- Did not start worker-backed jobs.
- Did not expose profile data, resumes, PDFs, logs, SQLite contents, OAuth data, or secrets in this artifact.

