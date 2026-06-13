---
phase: 16-product-path-qa-documentation
status: passed
verified_at: 2026-06-11
---

# Phase 16 Verification: Product-Path QA + Documentation

**Date:** 2026-06-11
**Status:** Passed

## Commands

| Command | Result |
|---------|--------|
| `corepack pnpm api:check` | Pass |
| `corepack pnpm --filter @jobhunter/api test -- apply-audit application-feedback server` | Pass, 11 files / 207 tests |
| `corepack pnpm web:check` | Pass |
| `corepack pnpm --filter @jobhunter/web test src/views/apply-review/ApplyReviewView.test.tsx src/views/jobs/JobDetailDrawer.test.tsx src/views/jobs/JobOverview.test.tsx` | Pass, 3 files / 20 tests |
| `corepack pnpm web:build` | Pass, with existing Vite large-chunk warning |
| `git diff --check` | Pass |

## Browser QA

QA used a paired current-checkout API and web server:

- API: `JOBHUNTER_API_PORT=8876 corepack pnpm --filter @jobhunter/api start`
- Web: `VITE_DEV_API_PROXY_TARGET=http://127.0.0.1:8876 corepack pnpm --dir apps/web exec vite --host 127.0.0.1 --port 5277`

### Jobs Drawer

Verified product path:

1. Opened `/jobs`.
2. Activated a visible Jobs table `Open` control.
3. Confirmed the job drawer opened.
4. Confirmed audit triage title `Why this job is here`.
5. Confirmed ranking summary exists.
6. Confirmed apply readiness section exists.
7. Confirmed eligibility section exists.
8. Confirmed the Apply Review handoff target is `/apply-review`.

### Apply Review

Verified product path:

1. Opened `/apply-review`.
2. Confirmed selected application mounted.
3. Confirmed status label `materials ready`.
4. Confirmed status note is driven by the shared apply audit summary.
5. Confirmed `Rendered resume audit` exists.
6. Confirmed rendered resume preview exists before the claim pin region.
7. Confirmed claim pin region exists.
8. Confirmed no-provenance state is explicit for the local artifact tested.
9. Confirmed full tailoring rationale remains available below the resume-centered surface.
10. Confirmed decision controls remain present.

Automated tests cover the populated provenance path with synthetic data:

- source-to-tailored detail
- grounded/risky claim labels
- unsupported claim display
- missing required evidence display
- residual warning lifecycle display
- no-provenance fallback

## Safety

- Did not run auto-apply.
- Did not trigger browser submission.
- Did not scan mailboxes.
- Did not regenerate or replace materials.
- Did not start worker-backed jobs.
- Did not expose profile data, resumes, PDFs, logs, SQLite contents, OAuth data, or secrets in this artifact.
