# Roadmap: JobHunter - Grounded Resume Tailoring

## Milestones

- ✅ **v1.3 Salary Range Estimator** — Phases 17-22, shipped 2026-06-21 ([roadmap archive](milestones/v1.3-ROADMAP.md), [requirements archive](milestones/v1.3-REQUIREMENTS.md), [audit](milestones/v1.3-MILESTONE-AUDIT.md)).
- ✅ **v1.2 Apply Review Audit UX - Drawer + Resume Pins** — Phases 12-16, shipped 2026-06-13 ([roadmap archive](milestones/v1.2-ROADMAP.md), [requirements archive](milestones/v1.2-REQUIREMENTS.md), [audit](milestones/v1.2-MILESTONE-AUDIT.md)).
- ✅ **v1.1 shadcn standard-token migration + preset b3F5kqmYd8** — Phases 6-10, shipped before v1.2; final cleanup folded into v1.2 Phase 12.
- ✅ **v1.0 Grounded Resume Tailoring** — Phases 1-5, verified 2026-06-09.

## Current Focus

No active milestone is open. Start the next milestone with `$gsd-new-milestone`.

## Completed Milestone Summary

<details>
<summary>✅ v1.3 Salary Range Estimator (Phases 17-22) — SHIPPED 2026-06-21</summary>

v1.3 makes compensation facts inspectable in Jobs triage without turning uncertain salary evidence into hidden ranking, filtering, or apply gates. The milestone locked source-access policy, added posted salary facts, added company-role reported market estimates, propagated canonical compensation data through API/read models/SSE, exposed Jobs list/drawer compensation audit UI, and closed with product-path QA proving the feature remains warning-only and audit-first.

- [x] Phase 17: Source Registry & Access Policy — 2/2 plans
- [x] Phase 18: Posted Compensation Facts — 2/2 plans
- [x] Phase 19: Company-Role Reported Market Estimates — 2/2 plans
- [x] Phase 20: Canonical Read Model & Realtime API — 2/2 plans
- [x] Phase 21: Jobs Triage UX & Warning-Only Floor — 5/5 plans
- [x] Phase 22: Product-Path QA & Safety Release — 4/4 plans

Artifacts:

- [Roadmap archive](milestones/v1.3-ROADMAP.md)
- [Requirements archive](milestones/v1.3-REQUIREMENTS.md)
- [Milestone audit](milestones/v1.3-MILESTONE-AUDIT.md)
- [Phase execution archive](milestones/v1.3-phases/)

Residual tech debt:

- Provider-labeled local reported-compensation imports rely on source-policy/operator authorization before import, not an import-time permission gate.
- Phase 17 and 18 validation files remain plan-style artifacts even though their verification artifacts passed.

</details>

<details>
<summary>✅ v1.2 Apply Review Audit UX - Drawer + Resume Pins (Phases 12-16) — SHIPPED 2026-06-13</summary>

- [x] Phase 12: Folded Cleanup + Verification Baseline — 2/2 plans
- [x] Phase 13: Shared Apply Audit Contract — 2/2 plans
- [x] Phase 14: Jobs Drawer Audit Triage — 2/2 plans
- [x] Phase 15: Apply Review Resume Pins — 2/2 plans
- [x] Phase 16: Product-Path QA + Documentation — 2/2 plans

Artifacts:

- [Roadmap archive](milestones/v1.2-ROADMAP.md)
- [Requirements archive](milestones/v1.2-REQUIREMENTS.md)
- [Milestone audit](milestones/v1.2-MILESTONE-AUDIT.md)
- [Phase execution archive](milestones/v1.2-phases/)

</details>

## Progress

| Milestone | Phases | Plans | Status | Shipped |
| --- | ---: | ---: | --- | --- |
| v1.3 Salary Range Estimator | 6 | 17 | Complete | 2026-06-21 |
| v1.2 Apply Review Audit UX - Drawer + Resume Pins | 5 | 10 | Complete | 2026-06-13 |
| v1.1 shadcn standard-token migration + preset b3F5kqmYd8 | 5 | n/a | Complete | before v1.2 |
| v1.0 Grounded Resume Tailoring | 5 | n/a | Complete | 2026-06-09 |

## Coverage

- v1.3 requirements: 35 total, 35 complete, 0 unmapped, 0 duplicate mappings.
- Latest audit: `.planning/milestones/v1.3-MILESTONE-AUDIT.md`.

---
*Last updated: 2026-06-21 after v1.3 milestone archive*
