---
phase: 21
slug: jobs-triage-ux-warning-only-floor
status: passed
nyquist_compliant: true
wave_0_complete: true
created: 2026-06-20
---

# Phase 21 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.5, React Testing Library 16.3.2, MSW 2.14.3, jest-axe 9.0.0 |
| **Config file** | `apps/web/vitest.config.ts`; type-level config `apps/web/vitest.types.config.ts` |
| **Quick run command** | `corepack pnpm --filter @jobhunter/web test src/views/jobs/JobsView.test.tsx src/views/jobs/JobDetailDrawer.test.tsx src/views/jobs/JobDetailDrawer.a11y.test.tsx` |
| **Full suite command** | `corepack pnpm web:check && corepack pnpm web:build && corepack pnpm --filter @jobhunter/web test` |
| **Estimated runtime** | ~180 seconds for focused web checks; longer for full suite |

---

## Sampling Rate

- **After every task commit:** Run the quick Jobs view/drawer test command, or the smallest focused subset that covers the touched file plus `corepack pnpm web:check`.
- **After every plan wave:** Run `corepack pnpm --filter @jobhunter/web test`, `corepack pnpm web:build`, and any API/Python projection parity tests if floor-comparison DTO work touched backend contracts.
- **Before `$gsd-verify-work`:** Full web suite plus documented browser QA for `/jobs` must be green.
- **Max feedback latency:** 300 seconds for focused UI tasks before proceeding to the next task.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 21-TBD-01 | TBD | TBD | UI-01 | T-21-02 | Compensation columns remain display-only and do not affect sorting, filtering, ranking, readiness, blockers, or dispatch. | component/static | `corepack pnpm --filter @jobhunter/web test src/views/jobs/JobsView.test.tsx` | yes | pending |
| 21-TBD-02 | TBD | TBD | UI-02 | T-21-01 | Drawer compensation audit renders only safe projected compensation fields and no raw provider payloads, credentials, local paths, or private profile data beyond safe comparison facts. | component/a11y | `corepack pnpm --filter @jobhunter/web test src/views/jobs/JobDetailDrawer.test.tsx src/views/jobs/JobDetailDrawer.a11y.test.tsx` | yes | pending |
| 21-TBD-03 | TBD | TBD | UI-03 | T-21-02 | Floor comparison is warning-only and does not appear in Apply concerns, missing prerequisites, hard blockers, fit score, filters, ranking, or dispatch conditions. | component/static | `corepack pnpm --filter @jobhunter/web test src/views/jobs/JobsView.test.tsx src/views/jobs/JobDetailDrawer.test.tsx` | yes | pending |
| 21-TBD-04 | TBD | TBD | UI-04 | T-21-03 | Drawer explicitly names the basis: posted salary, market estimate, both, no comparable basis, or floor not configured. | component | `corepack pnpm --filter @jobhunter/web test src/views/jobs/JobDetailDrawer.test.tsx` | yes | pending |
| 21-TBD-05 | TBD | TBD | UI-05 | T-21-04 | Compact dashes have accessible labels and drawer detail explains missing, unsupported, insufficient-evidence, and source-unavailable states. | component/a11y | `corepack pnpm --filter @jobhunter/web test src/views/jobs/JobsView.test.tsx src/views/jobs/JobDetailDrawer.a11y.test.tsx` | yes | pending |
| 21-TBD-06 | TBD | TBD | UI-06 | T-21-04 | Mobile and desktop layouts preserve separate Posted, Market, and Warnings columns with horizontal scroll and no text overlap. | browser/manual or e2e | `corepack pnpm --filter @jobhunter/web e2e -- tests/jobs-drawer.spec.ts` if updated; otherwise documented manual `/jobs` QA | yes | pending |
| 21-TBD-07 | TBD | TBD | UI-03, UI-04 | T-21-01 | If a floor-comparison DTO is added, shared contract/API/projection tests prove only numeric profile floor is used and unsafe profile strings are ignored. | API/contract | `corepack pnpm api:test` and relevant Python projection parity if worker projection code changes | yes | pending |

Threat references:
- `T-21-01`: Information disclosure through unsafe compensation/source/profile payload display.
- `T-21-02`: Hidden salary gate affecting sort/filter/ranking/apply readiness/blockers/dispatch.
- `T-21-03`: False precision or misleading basis for floor comparison.
- `T-21-04`: Accessibility or layout denial of usability through unlabeled dashes, color-only warnings, or overlap.

---

## Wave 0 Requirements

- [ ] `apps/web/src/test/fixtures/projections.ts` - add synthetic compensation summary/audit fixture builders and floor-comparison cases.
- [ ] `apps/web/src/views/jobs/JobsView.test.tsx` - prove three compensation columns, accessible dash labels, no compensation sorting/filtering, warning count semantics, and null-summary fallback.
- [ ] `apps/web/src/views/jobs/JobDetailDrawer.test.tsx` - prove compensation audit section order, evidence rendering, disclosure labels, unavailable reasons, and floor-basis copy.
- [ ] `apps/web/src/views/jobs/JobDetailDrawer.a11y.test.tsx` - keep or extend axe coverage for drawer disclosure and warning/missing states.
- [ ] If floor comparison needs backend support: add shared contract/API/projection tests before UI relies on the field.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Narrow Jobs table preserves separate columns without overlap | UI-06 | Horizontal scroll and text overlap need browser viewport inspection beyond RTL assertions. | Start the app, open `/jobs` with synthetic seeded compensation fixtures, resize below tablet width, verify `Posted`, `Market`, and `Warnings` remain separate columns inside horizontal scroll. |
| Drawer compensation audit visual hierarchy | UI-02, UI-06 | The section must sit directly after `Why this job is here` and remain scan-friendly in real CSS. | Open a compensated job drawer, verify `Compensation audit` appears immediately below audit triage and before description, top summary is first, evidence disclosures follow. |
| Warning-only product boundary | UI-03 | Product path needs end-to-end visual inspection across nearby controls. | Confirm compensation warnings do not appear in Apply concerns, missing prerequisites, hard blockers, fit score, ranking controls, filters, or dispatch/apply controls. |

---

## Validation Sign-Off

- [x] All planned task areas have automated verification or explicit Wave 0 dependencies.
- [x] Sampling continuity: no 3 consecutive tasks may proceed without an automated verify command.
- [x] Wave 0 covers fixture and missing-reference setup.
- [x] No watch-mode flags.
- [x] Feedback latency target is under 300 seconds for focused checks.
- [x] `nyquist_compliant: true` set in frontmatter.

**Approval:** approved 2026-06-20
