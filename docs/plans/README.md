# Plan Archive

Plans are historical working documents. Canonical project documentation lives
at the top of `docs/`.

- Top level: accepted plans that are not fully delivered.
- `implemented/`: plans, specs, QA checklists, and delivery notes for work
  that has landed, been superseded by canonical docs, or been closed with a
  recorded outcome.

As of 2026-07-10, the bundled distribution plan below is the only active dated
plan at the top level. Earlier dated plans have landed or been closed with a
recorded outcome and live under `implemented/`. Add new
accepted-but-not-yet-delivered plans at the top level.

When a plan is fully implemented, move it into `implemented/` with a status
banner recording the delivery PRs and any deviations, and update the canonical
docs to describe the delivered behavior. Delivery history lives in the git log
(Conventional Commits) and in the plan records themselves; the separate
`docs/delivered.md` changelog was retired on 2026-07-04.

## Active Plans

| Date | Plan | Status |
| --- | --- | --- |
| 2026-07-10 | [Bundled JobCtrl Distribution](2026-07-10-bundled-jobctrl-distribution-plan.md) | Active — P0–P6 implementation stack prepared; signed publication and P7 published-artifact QA remain external gates |

## Historical Spec Ledger

The full inventory of every plan or spec that has shaped JobCtrl — both the
plans tracked in this repository and the private planning corpus that was
untracked before the open-source release. Dates are each plan's authored/landed
date (the filename convention). Delivery detail also lives in each plan's status
banner, the git log, and the matching entry in `../decisions.md`.

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
| 2026-07-10 | [Bundled JobCtrl Distribution](2026-07-10-bundled-jobctrl-distribution-plan.md) | Active — P0–P6 implementation stack prepared; signed publication and P7 published-artifact QA pending; ADR 2026-07-10 |

Two 2026-05-17 backlog specs (`…-add-react`, `…-add-brows`) were drafted on
`origin/mestre/develop-*` branches and never merged to `main`; only `…-add-root`
(#70) landed. The other two survive only on those branch tips, not in `main`
history.

### Private planning corpus (`.planning/`, untracked)

`.planning/` held the milestone planning corpus — project research, milestone
roadmaps, per-phase plans/summaries/verification records, codebase analysis
maps, and UI sketches. It was untracked at commit `9bc9edc2`
("chore(release): untrack private planning corpus and strip private banners",
PR #242) as part of the OSS release (W0.1) because it can contain private data.
Content remains in git history before `9bc9edc2` and locally in the gitignored
`.planning/` directory. **143 files** at the time of untracking. The topics below
are derived from directory and slug names only; file contents — especially the
root project charter and retrospective and the compensation milestone — are
private and withheld here.

| Group | Files | Topics (from slugs) |
| --- | --- | --- |
| `.planning/` (root) | 7 | project charter, milestones index, milestone-acceptance, roadmap, retrospective, session state, config (contents withheld) |
| `.planning/codebase/` | 7 | codebase analysis maps: architecture, concerns, conventions, integrations, stack, structure, testing |
| `.planning/research/` | 5 | project research: architecture, features, pitfalls, stack, summary |
| `.planning/milestones/` (milestone-level) | 6 | per-milestone audit / requirements / roadmap for v1.2 and v1.3 |
| `.planning/milestones/v1.2-phases/` | 41 | v1.2 "audit UX" phases 12–16 (below) |
| `.planning/milestones/v1.3-phases/` | 71 | v1.3 "compensation / jobs-triage" phases 17–22 (below) |
| `.planning/sketches/` | 6 | apply-review audit UI HTML/CSS prototypes (two sketches, manifest, theme; HTML files may embed sample data) |

Each phase folder holds generic working-doc types (PLAN, SUMMARY, CONTEXT,
RESEARCH, PATTERNS, VERIFICATION, VALIDATION, UI-SPEC, PLAN-CHECK, REVIEW,
DISCUSSION-LOG). The phase slugs map to features now recorded as ADRs in
`../decisions.md` (audit-from-canonical-rows, requirement-fit ledger,
compensation).

**v1.2 phases (audit UX), 41 files**

| Phase | Files |
| --- | --- |
| 12 folded-cleanup-verification-baseline | 8 |
| 13 shared-apply-audit-contract | 9 |
| 14 jobs-drawer-audit-triage | 9 |
| 15 apply-review-resume-pins | 8 |
| 16 product-path-qa-documentation | 7 |

**v1.3 phases (compensation + jobs triage), 71 files**

| Phase | Files |
| --- | --- |
| 17 source-registry-access-policy | 9 |
| 18 posted-compensation-facts | 9 |
| 19 europe-public-market-estimates | 9 |
| 20 canonical-read-model-realtime-api | 9 |
| 21 jobs-triage-ux-warning-only-floor | 19 |
| 22 product-path-qa-safety-release | 16 |
