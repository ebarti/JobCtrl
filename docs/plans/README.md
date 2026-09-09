# Plan Archive

Plans are historical working documents. Canonical project documentation lives
at the top of `docs/`.

- Top level: accepted plans that are not fully delivered.
- `implemented/`: plans, specs, QA checklists, and delivery notes for work
  that has landed, been superseded by canonical docs, or been closed with a
  recorded outcome.

Accepted public implementation plans are listed below. Bundled distribution
and the public live demo are delivered and archived
under `implemented/`; their separately deferred operational and privacy
follow-ups live in `docs/publish-checklist.md` and `docs/backlog.md`. Add new
accepted-but-not-yet-delivered public product plans at the top level.

This is a public repository. Owner-only launch/growth strategy, campaign
sequencing, targeting, unpublished messaging, and private traffic or conversion
analysis must not be committed, listed, summarized, or archived here.

The former top-level `openspec/` corpus was consolidated here on 2026-07-12.
Each delivered change now has one implemented-plan record containing its
outcome, decisions, requirements, delivery evidence, deviations, and deferred
boundaries instead of separate proposal/design/spec/task copies.

When a plan is fully implemented, move it into `implemented/` with a status
banner recording the delivery PRs and any deviations, and update the canonical
docs to describe the delivered behavior. Delivery history lives in the git log
(Conventional Commits) and in the plan records themselves; the separate
`docs/delivered.md` changelog was retired on 2026-07-04.

## Active Plans

- [Preserve Behavior While Removing Duplicated State And Execution](2026-09-06-simplification-stack.md)
  — accepted; four stacked PRs for review drafts, profile editing and Tailor.
- [Stable Job Identity, Workflow Parity, And Feedback Learning](2026-07-29-stable-job-identity-workflow-feedback-learning.md)
  — accepted; implementation in progress as small stacked PRs.

## Historical Spec Ledger

This is the inventory of plans and specs tracked in this repository. Dates are
each plan's authored or landed date (the filename convention). Delivery detail
also lives in each plan's status banner, the git log, and the matching entry in
`../decisions.md`.

### Tracked plans

Plans were originally drafted under `docs/plans/proposed/` and renamed into
`implemented/` on delivery; the `proposed/` directory no longer exists. The DDD
and frontend plans were renamed from working titles (`ddd-target-plan.md`,
`frontend-tanstack-migration.md`) into the dated names below.

| Date | Plan | Status / delivered by |
| --- | --- | --- |
| 2026-04-29 | [Job State Dashboard](implemented/2026-04-29-job-state-dashboard.md) | Implemented — #1–#4 |
| 2026-05-01 | [TypeScript Product API + Python Workers Architecture](implemented/2026-05-01-ts-product-api-python-workers-architecture.md) | Implemented — #5 (plan), #8, #9, #15; ADR 2026-05-01 |
| 2026-05-02 | [Local TypeScript API](implemented/2026-05-02-local-ts-api.md) | Implemented — #8, #15 |
| 2026-05-03 | [Local Reliability QA](implemented/2026-05-03-local-reliability-qa.md) | Implemented — #13 |
| 2026-05-03 | [Remove Python Dashboard Compatibility](implemented/2026-05-03-remove-python-dashboard-compat.md) | Implemented — #17 |
| 2026-05-06 | [DDD Target-State Migration](implemented/2026-05-06-ddd-migration.md) | Implemented — #20 (plan), #21; ADR 2026-05-06 |
| 2026-05-06 | [Frontend TanStack Migration](implemented/2026-05-06-frontend-tanstack-migration.md) | Implemented — #23 (plan), #24–#31; ADR 2026-05-06 |
| 2026-05-07 | [Temporal + Worker Reliability Stack](implemented/2026-05-07-temporal-and-worker-reliability-stack.md) | Implemented — #34–#42; ADR 2026-05-07 |
| 2026-05-10 | [Job Scoring Intelligence](implemented/2026-05-10-job-scoring-intelligence.md) | Implemented — #46 (plan), #47, #48, #55, #60 |
| 2026-05-12 | [Ideal Job Search Discovery (RFC)](implemented/2026-05-12-job-search-discovery-rfc.md) | Implemented — #50 (plan), #51–#61 |
| 2026-05-17 | [Add Root-Level Web Test Aliases](implemented/2026-05-17-jobctrl-backlog-item-add-root.md) | Implemented — #70 |
| 2026-05-19 | [Calibrated Scoring Policy (RFC)](implemented/2026-05-19-calibrated-scoring-policy-rfc.md) | Implemented — #76 (plan), #77–#81 |
| 2026-05-24 | [Target Search Recall](implemented/2026-05-24-target-search-recall.md) | Implemented — #95, #97 |
| 2026-05-26 | [Single Discovery Preparation Stage](implemented/2026-05-26-single-discovery-preparation-stage.md) | Implemented — #101 (plan), #102–#107 |
| 2026-06-01 | [Apply Review Queue And Outcome Feedback — Design](implemented/2026-06-01-apply-review-outcome-feedback-design.md) | Implemented — design for #115–#117; ADR 2026-06-01 |
| 2026-06-01 | [Apply Review Queue And Outcome Feedback](implemented/2026-06-01-apply-review-outcome-feedback.md) | Implemented — #115, #116, #117; ADR 2026-06-01 |
| 2026-06-03 | [Resume Tailoring Quality](implemented/2026-06-03-resume-tailoring-quality.md) | Implemented — #123 (plan), #124–#128; ADR 2026-06-03 |
| 2026-06-15 | [Requirement Fit Ledger](implemented/2026-06-15-requirement-fit-ledger.md) | Implemented — #162–#177, #189; ADR 2026-06-15 |
| 2026-06-22 | [Swap LaTeX For HTML/CSS Resume Rendering](implemented/2026-06-22-swap-latex-for-html-css.md) | Implemented — #188, #210, #211, #220; ADR 2026-06-24 |
| 2026-06-25 | [Live Resume Editor, Review Comments, And Feedback Capture](implemented/2026-06-25-live-resume-editor-feedback.md) | Implemented — #190–#192 |
| 2026-06-26 | [Resume Template Editing And Lazy Material Refresh](implemented/2026-06-26-resume-template-editing.md) | Implemented — #193 |
| 2026-06-30 | [Requirement-Led Resume Tailoring](implemented/2026-06-30-requirement-led-resume-tailoring.md) | Implemented — #201–#203; hardened by #216, #224, #228, #229; ADR 2026-06-30 |
| 2026-07-03 | [Temporal-Native Rearchitecture](implemented/2026-07-03-temporal-native-rearchitecture.md) | Implemented — #230 (plan), #233, #231, #235, #238, #237, #239, #240; ADRs 2026-07-03 |
| 2026-07-03 | [Temporal Rearchitecture — Implementation Spec (P1b–P5)](implemented/2026-07-03-temporal-rearch-implementation-spec.md) | Implemented — spec #232 |
| 2026-07-03 | [OSS Release Remediation — Implementation Spec for Codex](implemented/2026-07-03-oss-release-remediation-spec.md) | Closed by #274 inventory, then W1 restamped after #336, #337, #338, #340, #342, and #345 — W1.1-W1.7 complete; W1.8 dry-run-by-default was withdrawn by owner decision; overall release remains no-go pending non-W1 owner/release checkpoints |
| 2026-07-05 | [OSS Release — Drive-to-Done and Completion Verification Plan](implemented/2026-07-05-oss-release-drive-to-done-plan.md) | Restamped after the W1 remediation train and W0.6 owner pass — W1 apply-safety and the W2.1 rename are complete; W2.4 was explicitly deferred for v2.0.0 on 2026-07-10; overall R1 remains no-go pending final owner/release checkpoints and green post-public hosted gates |
| 2026-07-05 | [Low-Friction Install & Auth Reuse](implemented/2026-07-05-low-friction-install-plan.md) | Implemented — #254 (plan), #317, #354 |
| 2026-07-05 | [First-Run Time-to-Value: Real-Path Measurement Discipline](implemented/2026-07-05-first-run-ttfv-plan.md) | Implemented / closed — #259 (plan), #343; Goal B withdrawn and #330 closed unmerged; desktop-packaging verdict remains pending owner-run TTFV evidence |
| 2026-07-05 | [Streaming Pipeline Latency — Score As You Discover](implemented/2026-07-05-streaming-pipeline-latency-plan.md) | Implemented — #260 (plan), #301, #306, #311; decisions recorded in #318 |
| 2026-07-05 | [Launch-Readiness Artifacts](implemented/2026-07-05-launch-readiness-artifacts-plan.md) | Implemented / closed — #262 (plan), #298-#305, #324, #341, #354; owner-only publish actions remain in `docs/publish-checklist.md` |
| 2026-07-05 | [Career Evidence Map + Interview Preparation](implemented/2026-07-05-evidence-map-interview-prep-plan.md) | Implemented — #263 (plan), #276, #279, #283, #285, #293, #294 |
| 2026-07-05 | [Application Outcome Analytics And Artifact Comparison](implemented/2026-07-05-outcome-analytics-plan.md) | Implemented — #264 (plan), #273, #280, #284, #287, #295 |
| 2026-07-05 | [Browser Extension — Capture, Assisted Autofill, and Deferred Guarded Submission](implemented/2026-07-05-browser-extension-plan.md) | Implemented through deterministic capture/autofill — #265 (plan), #277, #281, #282; P2b free-text drafts and P3 guarded submission remain deferred |
| 2026-07-05 | [Saved Table Views + Daily Local Digest](implemented/2026-07-05-saved-views-daily-digest-plan.md) | Implemented — #267 (plan), #288-#292 |
| 2026-07-05 | [Contact Research And Outreach Planner](implemented/2026-07-05-outreach-planner-plan.md) | Implemented — #266 (plan), #325, #331, #332, #333, #335, #347; ADR 2026-07-06 |
| 2026-07-05 | [Product Rename to JobCtrl](implemented/2026-07-05-rename-jobctrl-plan.md) | Implemented — #261 (plan), #349; hardening #350; #351 closeout; R0.1 updates the final public spelling to JobCtrl |
| 2026-07-05 | [Crawl Politeness Hardening](implemented/2026-07-05-crawl-politeness-plan.md) | Implemented — #272 (plan), #297-#316; pacing-test hardening #334; ADR 2026-07-06 |
| 2026-07-08 | [Web UI/UX Revamp — Left-Rail Shell + JobCtrl Design System](implemented/2026-07-08-web-ui-revamp-plan.md) | Implemented — #356; design-system docs follow-up continues separately in #357 |
| 2026-07-10 | [Bundled JobCtrl Distribution](implemented/2026-07-10-bundled-jobctrl-distribution-plan.md) | Implemented / closed with operational follow-ups — #394, #396, and #399–#405; signed/notarized `v2.0.7`, GitHub Release, R2, Homebrew, and PyPI are live; published-artifact acceptance remains in the release checklist/backlog; ADR 2026-07-10 |
| 2026-07-11 | [Public JobCtrl Live Demo](implemented/2026-07-11-public-live-demo-plan.md) | Implemented / public — #407–#417; consent-gated analytics #497; analytics-optional access and withdrawal/erasure remain separately scoped privacy follow-ups |
| 2026-07-13 | [Discovery Pipeline Operations Visibility](implemented/2026-07-13-discovery-pipeline-operations-visibility-plan.md) | Implemented — cumulative integration #464 incorporated the reviewed #459–#462 stack; production follow-ups #465–#467 |
| 2026-07-14 | [End-to-End Product Redesign](implemented/2026-07-14-end-to-end-product-redesign.md) | Implemented — cumulative integration #464 incorporated the reviewed #453–#463 stack; production follow-ups #465–#467 |
| 2026-07-17 | [Resumable JobStreaming Discovery](implemented/2026-07-17-resumable-jobstreaming-discovery-plan.md) | Implemented — provider boundary #468, durable units #469, and Temporal resume/docs/QA #470 |

Two 2026-05-17 backlog specs (`…-add-react`, `…-add-brows`) were drafted on
`origin/mestre/develop-*` branches and never merged to `main`; only `…-add-root`
(#70) landed. The other two survive only on those branch tips, not in `main`
history.
