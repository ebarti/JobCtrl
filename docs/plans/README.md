# Plan Archive

Plans are historical working documents. Canonical project documentation lives
at the top of `docs/`.

- Top level: accepted plans that are not fully delivered.
- `implemented/`: plans, specs, QA checklists, and delivery notes for work
  that has landed, been superseded by canonical docs, or been closed with a
  recorded outcome.

When a plan is fully implemented, move it into `implemented/` with a status
banner recording the delivery PRs and any deviations, and update the canonical
docs to describe the delivered behavior. Delivery history lives in the git log
(Conventional Commits) and in the plan records themselves; the separate
`docs/delivered.md` changelog was retired on 2026-07-04.

## Historical Spec Ledger

The full inventory of every plan or spec that has shaped JobHunter — both the
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
| 2026-05-17 | [Add Root-Level Web Test Aliases](implemented/2026-05-17-jobhunter-backlog-item-add-root.md) | Implemented — #70 |
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
| 2026-07-03 | [OSS Release Remediation — Implementation Spec for Codex](implemented/2026-07-03-oss-release-remediation-spec.md) | Closed by #274 inventory; **not release-ready** — W1.2–W1.8, W2.2 doctor notices, W2.4, W2.6, and owner rename/release checkpoints remain open |
| 2026-07-05 | [OSS Release — Drive-to-Done and Completion Verification Plan](implemented/2026-07-05-oss-release-drive-to-done-plan.md) | Closed by #274 inventory; **no-go** — remaining items are W1.2–W1.8, W2.2 doctor notices, W2.4, W2.6, and owner rename/release checkpoints |

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
