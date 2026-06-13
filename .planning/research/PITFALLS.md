# Pitfalls Research

**Domain:** Local-first job-application audit UX
**Researched:** 2026-06-11
**Confidence:** HIGH for auditability and scope pitfalls, MEDIUM for pin placement risks

## Critical Pitfalls

### Pitfall 1: Contradictory Readiness Labels

**What goes wrong:**
Jobs drawer, Apply Review queue, selected header, and decision controls show different readiness/blocker facts for the same job.

**Why it happens:**
Each UI surface derives its own status from a subset of fields. The current Apply Review view already has local `materialStatus` logic while the API queue exposes a simpler `materials.ready` field.

**How to avoid:**
Create one shared readiness/blocker contract in the API/read model and consume it in both surfaces. UI helpers can format labels, but cannot decide source facts.

**Warning signs:**
- New helpers named `materialStatus` or `readinessStatus` inside views.
- Tests assert labels without checking the API contract.
- `materials.ready` and blocker labels are not derived from the same source.

**Phase to address:** Phase 13 shared audit contract.

---

### Pitfall 2: Ranking Explanation Implemented in the Wrong Surface

**What goes wrong:**
The milestone explains ranking in Apply Review but leaves the Jobs row-click drawer vague.

**Why it happens:**
Apply Review currently shows requirement evidence and can open job details, so it is tempting to keep adding ranking content there.

**How to avoid:**
Keep the scope split explicit: Jobs drawer owns rank explanation, readiness, blockers, and eligibility concerns. Apply Review owns generated-material inspection.

**Warning signs:**
- Jobs drawer still starts with generic "Preparation diagnostics" before rank/readiness triage.
- Apply Review becomes the only place a user can answer why the job ranked highly.

**Phase to address:** Phase 14 Jobs drawer audit triage.

---

### Pitfall 3: Resume Pins That Are Decorative Instead of Auditable

**What goes wrong:**
Pins appear on or near the resume but do not open concrete source evidence, transformed text, grounding status, or risk.

**Why it happens:**
The UI work focuses on layout before deriving a pin model from `bulletProvenance`, `annotatedChanges`, and judge/quality data.

**How to avoid:**
Define a pin model first. Every pin must point to a generated claim/bullet and show source profile/resume text, requirements/evidence IDs, transform/change type, grounding/risk, and reviewer action where available.

**Warning signs:**
- Pins are keyed by array index only.
- Pins do not survive sorting/filtering/re-rendering.
- Pin detail cannot name source evidence or generated text.

**Phase to address:** Phase 15 Apply Review resume pins.

---

### Pitfall 4: Missing Audit Data Hidden for Polish

**What goes wrong:**
Unsupported claims, missing evidence, missing prompt/judge details, absent source bullets, or incomplete material status are hidden or renamed to make the UI feel cleaner.

**Why it happens:**
Audit gaps look embarrassing in review surfaces.

**How to avoid:**
Preserve explicit missing states and fix missing audit sources in the owning layer when the source should exist.

**Warning signs:**
- Empty arrays return `null` instead of an explicit empty state.
- "not recorded" states disappear from inspector components.
- PR text says a field was removed because it was confusing without source-of-truth remediation.

**Phase to address:** All phases; especially Phases 13 and 15.

---

### Pitfall 5: QA Accidentally Uses Sensitive or Live Application Flows

**What goes wrong:**
Browser proof exposes local resume/profile/application data or triggers apply/browser submission/worker-backed actions.

**Why it happens:**
The most realistic path is a running local app with real data, but this repo treats generated materials and local artifacts as sensitive.

**How to avoid:**
Use synthetic seeded fixtures or scrubbed static examples. QA must not run auto-apply, browser submission, mailbox scanning, real material generation, destructive profile/database actions, or worker-backed jobs unless explicitly requested.

**Warning signs:**
- Screenshots show real company/candidate identifiers from the user environment.
- QA command starts `jobhunter run`, a Temporal worker, apply automation, or browser submission without explicit approval.

**Phase to address:** Phase 16 QA/docs.

---

### Pitfall 6: Folded Cleanup Overtakes the Product Milestone

**What goes wrong:**
The leftover v1.1 cleanup expands into broad styling, route, or dependency refactors before the audit UX is delivered.

**Why it happens:**
Cleanup items are easy to chase because they touch many files and have obvious grep targets.

**How to avoid:**
Limit cleanup to stale verification command normalization, dependency/config audit, obsolete `lucide-react` removal only if imports are zero, and narrow docs/config updates.

**Warning signs:**
- Cleanup phase changes product layout or route behavior.
- Cleanup PR touches unrelated design tokens beyond stale references.
- No audit UX phases are planned yet.

**Phase to address:** Phase 12 folded cleanup.

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Formatting readiness in the UI from raw fields | Fast visible labels | Permanent cross-surface drift | Never for shared facts. |
| Pins keyed by visual order | Quick prototype | Breaks proof when rendering changes | Only in throwaway sketches, not production. |
| Missing keyword list inferred from job keywords | Easy to fill UI | False audit claims | Never; use coverage audit or rendered text with provenance. |
| Adding new UI components inside views only | Fast local change | Reuse and testing suffer | Acceptable only for pure layout composers. |
| Deferring API tests for read-model DTOs | Faster PR | Contract regressions slip to browser QA | Not acceptable for shared contract changes. |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Contracts/API/web | Add fields to web types without API mapper tests | Add DTO fields in `@jobhunter/contracts`, map in API, and cover with tests/typecheck. |
| Apply Review and Jobs drawer | Duplicate blocker formatting | Share source facts; localize only labels or compact display variants. |
| PDF preview and pins | Assume PDF page coordinates are stable | Anchor to generated text/provenance first and show fallback when visual location cannot be established. |
| Storybook/QA fixtures | Reuse local artifacts | Use synthetic data and scrubbed examples. |
| Icon cleanup | Remove dependency before import proof | Run import/dependency audit before removing `lucide-react`. |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Dense audit panels disconnected from the resume | User cannot connect evidence to the artifact they approve. | Put pins/markers on or beside the rendered resume and show detail on selection. |
| Generic "materials not ready" tag | User does not know why review is blocked. | Show concrete prerequisites and blocker source. |
| Ranking mixed with material proof | User cannot tell whether a problem is job fit or generated artifact risk. | Jobs drawer owns fit/readiness; Apply Review owns artifact proof. |
| Over-explaining process text in the app | Slows repeated review workflow. | Use compact labels, disclosure, pins, and inspector detail. |
| Hero/marketing treatment | Misfits dense operational tool usage. | Keep a utilitarian, scannable, work-focused layout. |

## Looks Done But Is Not Checklist

- [ ] **Readiness:** Both surfaces show labels, but tests do not assert they come from the same contract.
- [ ] **Jobs drawer:** It contains score details, but no clear answer to "why ranked this way."
- [ ] **Apply Review:** It shows provenance cards, but selecting a resume line/claim does not reveal source and risk.
- [ ] **Pins:** They exist visually, but cannot name source profile/resume text and generated text.
- [ ] **Claim risk:** Judge/adversarial warnings are present somewhere, but not connected to specific generated claims or accepted lifecycle state.
- [ ] **QA:** Browser screenshots look good, but data is real or the apply path was triggered.
- [ ] **Cleanup:** `lucide-react` is removed without import/dependency proof, or stale Tailwind config references remain.

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Contradictory readiness labels | Phase 13 | API/read-model tests plus browser proof of same job in Jobs drawer and Apply Review. |
| Ranking explanation in wrong surface | Phase 14 | Jobs drawer test/browser QA answers rank/readiness/blocker stories without opening Apply Review. |
| Decorative pins | Phase 15 | Component tests assert pin detail includes source, generated text, transform, evidence, grounding, risk. |
| Hidden missing audit data | Phases 13-15 | Empty/missing-state tests and review checklist. |
| Sensitive/live QA | Phase 16 | QA evidence uses synthetic data and records no auto-apply/submission commands. |
| Cleanup scope creep | Phase 12 | Diff scoped to stale config/dependency/docs proof. |

## Sources

- `AGENTS.md` auditability and QA discipline.
- `apps/web/src/views/apply-review/ApplyReviewView.tsx`
- `apps/web/src/views/jobs/JobDetailDrawer.tsx`
- `apps/api/src/application-feedback.ts`
- `packages/contracts/src/schemas.ts`
- `.planning/sketches/002-layered-audit-surfaces/README.md`

---
*Pitfalls research for: v1.2 Apply Review Audit UX - Drawer + Resume Pins*
*Researched: 2026-06-11*
