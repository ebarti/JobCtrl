---
phase: 17-source-registry-access-policy
status: passed
verified_at: 2026-06-19
---

# Phase 17 Verification: Source Registry & Access Policy

**Date:** 2026-06-19
**Status:** Passed

## Commands

| Command | Result |
|---------|--------|
| `corepack pnpm --filter @jobhunter/api exec vitest run test/compensation-source-policy.test.ts` | Pass, 1 file / 6 tests |
| `corepack pnpm --filter @jobhunter/api check` | Pass |
| `corepack pnpm --filter @jobhunter/web exec vitest run src/contexts/operations/hooks/useCompensationSourcePolicyQuery.test.ts src/contexts/scoring/components/CompensationSourcePolicyPanel.test.tsx` | Pass, 2 files / 6 tests |
| `corepack pnpm --filter @jobhunter/web check` | Pass |
| `git diff --check origin/plan/salary-range-estimator...HEAD` | Pass |
| `git diff --check` | Pass |

## Product Path QA

QA used a paired current-branch API and web server on alternate ports because `127.0.0.1:8766` was already occupied by another local JobHunter API:

- API: `JOBHUNTER_API_PORT=8767 corepack pnpm --filter @jobhunter/api dev`
- Web: `VITE_DEV_API_PROXY_TARGET=http://127.0.0.1:8767 corepack pnpm --filter @jobhunter/web exec vite --host 127.0.0.1 --port 5175 --strictPort`

Verified product path:

1. `GET http://127.0.0.1:8767/v1/compensation/sources` returned six source policies.
2. Posted salary text, Eurostat SES, ESCO, and Spain INE returned available public/local source policies.
3. Levels.fyi and Glassdoor returned unavailable policies with `unavailable_until_permitted` access modes.
4. Opened `/settings` on desktop and mobile viewports.
5. Confirmed the `Compensation sources` panel rendered below the existing Settings config panel.
6. Confirmed Eurostat, Levels.fyi, and Glassdoor rows rendered with disabled reasons.
7. Confirmed the panel has one table, no buttons, no nested cards, no body overflow, and no browser console/page errors on desktop or mobile.

## Review And QA Gates

- `pr-reviewer` initially found one blocker in committed planning whitespace and one medium test weakness. Both were fixed.
- `qa` returned `Gate: PASS`; its low whitespace note was fixed.

## Safety

- Did not run auto-apply.
- Did not trigger browser submission.
- Did not scan mailboxes.
- Did not regenerate materials.
- Did not start worker-backed apply jobs.
- Did not add Glassdoor or Levels.fyi compensation fetch, scrape, cache, import, or provider credential paths.
- Did not expose profile data, resumes, PDFs, logs, SQLite contents, OAuth data, or secrets in this artifact.
