# Apply Review Queue And Outcome Feedback Implementation Plan

> **Status:** Implemented. Canonical current behavior is documented in
> `README.md`, `docs/local-ts-api.md`, `docs/local-reliability-qa.md`, and
> `docs/architecture.md`; the delivery summary is in `docs/delivered.md`.

**Goal:** Add a user-approved apply review queue and outcome tracking loop with Gmail-only email feedback.

**Architecture:** Extend the existing Apply, Pipeline, Operations, and Profile/Gmail boundaries without introducing a new CRM context. Use local SQLite tables for review decisions, reviewed outcomes, linked email evidence, and outcome suggestions; expose typed API routes and React views over those read models. Keep raw Gmail bodies out of event payloads, telemetry, logs, and broad dashboard projections.

**Tech Stack:** TypeScript contracts/API, Fastify routes, SQLite, React/TanStack Query, Vitest/RTL/MSW, Python Gmail infrastructure and pytest.

---

## File Map

- `packages/contracts/src/schemas.ts`: add review/outcome DTOs and request schemas.
- `packages/api-client/src/client.ts`: add client methods for review/outcome routes.
- `apps/api/src/application-feedback.ts`: new focused persistence/read/write helpers for review decisions, outcomes, suggestions, and safe Gmail scan request handling.
- `apps/api/src/server.ts`: register review/outcome API routes.
- `apps/api/test/application-feedback.test.ts`: API persistence and route coverage.
- `apps/web/src/contexts/apply/*`: review queue hooks/components.
- `apps/web/src/contexts/pipeline/*`: approved submit/dry-run decision mutation wiring where needed.
- `apps/web/src/contexts/operations/*`: query keys and hooks for review/outcome reads.
- `apps/web/src/views/apply-review/*`: review queue view composer.
- `apps/web/src/views/jobs/*`: compose outcome timeline in the job drawer.
- `apps/web/src/routes/apply-review.tsx`: route for review queue view.
- `workers/automation/src/jobhunter/infrastructure/gmail/feedback.py`: Gmail feedback scan, linking, body ingestion, and classification helpers.
- `workers/automation/tests/test_gmail_feedback.py`: Gmail feedback classifier/linking tests.
- `README.md`, `docs/local-ts-api.md`, `docs/local-reliability-qa.md`, `docs/architecture.md`, `docs/frontend-target.md`: narrow behavior/API/QA/docs updates.

## Stack Strategy

### PR 1: Foundation API And Manual Outcomes

- [ ] Create `feat/apply-review-foundation` from `origin/main`.
- [ ] Add schemas for `ApplicationOutcomeKind`, `ApplyReviewDecision`, `ApplicationOutcome`, `OutcomeSuggestion`, queue items, list responses, and mutation requests in `packages/contracts/src/schemas.ts`.
- [ ] Add `apps/api/src/application-feedback.ts` with idempotent table creation, queue derivation, decision writes, manual outcome writes, outcome reads, and safe event summaries.
- [ ] Add Fastify routes for review queue, review decision, manual outcome writes, job outcome reads, outcome list reads, and suggestion decisions.
- [ ] Add API tests that seed jobs/materials/stage rows, verify queue eligibility, approve/defer/decline decisions, write manual outcomes, and confirm raw outcome notes are not copied into `job_events.payload_json`.
- [ ] Update `README.md`, `docs/local-ts-api.md`, and `docs/architecture.md` with the new local review/outcome behavior.
- [ ] Run `pnpm api:test`, `pnpm api:check`, and `git diff --check`.
- [ ] Commit and open PR 1 as `feat: add apply review and outcome foundation`.

### PR 2: Review Queue And Outcome UI

- [ ] Create `feat/apply-review-ui` from PR 1.
- [ ] Add API client methods and Operations query hooks for review queue, job outcomes, and outcome suggestions.
- [ ] Add Apply context review queue components with semantic forms for approve dry-run, approve submit, defer, and decline.
- [ ] Add an `apply-review` route/view and AppShell navigation entry.
- [ ] Add job detail outcome timeline and manual outcome form.
- [ ] Add dashboard conversion metrics and pending suggestion count using existing dashboard composition patterns.
- [ ] Add MSW fixtures and component/hook tests for queue rendering, review decisions, manual outcome submit, and job drawer timeline.
- [ ] Update `docs/frontend-target.md` and `docs/local-reliability-qa.md`.
- [ ] Run `pnpm --filter @jobhunter/web test`, `pnpm web:check`, `pnpm web:build`, `pnpm api:test`, and `git diff --check`.
- [ ] Commit and open PR 2 as `feat: surface apply review and outcome tracking`.

### PR 3: Gmail Feedback Ingestion

- [ ] Create `feat/gmail-outcome-feedback` from PR 2.
- [ ] Add a Gmail feedback module separate from the verification-only MCP server. It may reuse OAuth/token loading but must expose bounded feedback-scan functions, not a general mailbox reader.
- [ ] Implement Gmail candidate search over application anchors using recipient, sender domain, employer/ATS hints, job title/company, and post-application time windows.
- [ ] Implement confidence scoring and only fetch full message bodies after the message is linked to a known application.
- [ ] Store `ApplicationEmailEvidence` locally with body text and body hash; write only safe evidence identifiers into events.
- [ ] Implement deterministic v1 classification for confirmations, recruiter replies, interviews, assessments, rejections, offers, bounces, and unknown.
- [ ] Add API/worker route or action to run a bounded Gmail feedback scan and create outcome suggestions.
- [ ] Add tests for no-body-before-link, linked-body-ingested, suggestion classification, duplicate Gmail message id dedupe, and no raw body in events/loggable summaries.
- [ ] Update `README.md`, `docs/local-ts-api.md`, `docs/local-reliability-qa.md`, and `docs/architecture.md` with Gmail feedback behavior and privacy constraints.
- [ ] Run focused Python Gmail tests, `uv --project workers/automation run --extra dev ruff check .`, `pnpm api:test`, `pnpm test`, and `git diff --check`.
- [ ] Commit and open PR 3 as `feat: ingest Gmail feedback for application outcomes`.

## Final Gate

- [ ] Run the full automated validation set after PR 3: `pnpm test`, `pnpm api:check`, `pnpm web:check`, `pnpm --filter @jobhunter/web test`, `uv --project workers/automation run --extra dev ruff check .`, and `git diff --check`.
- [ ] Run the PR review/fix loop for each stacked PR until Blocker/High findings are resolved.
- [ ] Stop before autonomous QA execution because the user requested manual QA at the end.
- [ ] Final report must include PR numbers, stack order, commands run with results, and any Medium/Low risks left for manual QA.

## Plan Self-Review

- Spec coverage: PR 1 covers durable review/outcome facts and API; PR 2 covers the user-facing review/outcome product surfaces; PR 3 covers Gmail-only linked body ingestion and suggestions.
- Placeholder scan: no implementation step relies on an unspecified placeholder.
- Type consistency: the plan uses `ApplyReviewDecision`, `ApplicationOutcome`, `ApplicationEmailEvidence`, and `OutcomeSuggestion` consistently with the design document.
