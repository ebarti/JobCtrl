---
phase: 09-domain-and-status-surface-migration
gathered: 2026-06-10T12:51:53Z
status: ready-for-planning
mode: auto-discussed
---

# Phase 09: Domain And Status Surface Migration - Context

## Phase Boundary

Phase 9 owns domain/status semantics after the shadcn standard-token migration. It must preserve distinct meanings for pipeline stages, stage states, scoring tiers, stale scores, artifact statuses, apply/workflow statuses, discovery source health, dashboard funnel/KPI segments, audit timelines, warnings, missing states, blocked states, running states, and failed states.

This phase must not change API contracts, TanStack route/search behavior, query keys, mutation behavior, SSE invalidation, generated materials policy, apply submission behavior, profile data, worker execution, or route information architecture. Route-wide browser QA is Phase 10. Dead CSS and unused dependency removal are Phase 11.

## Decisions

- Keep domain-to-visual mapping in typed helpers or explicit variant maps, not global CSS variables or unbounded string concatenation.
- Preserve honest audit surfaces. Missing provenance, missing keyword coverage, residual warnings, failed workflow state, stale scoring state, and historical suppressed artifacts stay visible.
- Retain semantic text labels alongside color. Status states must not be color-only.
- Keep chart tokens limited to chart/data emphasis. Lifecycle and workflow statuses continue using status tags, fit tiers, dots, and segment terms.
- Migrate remaining domain/view lucide icons to Tabler only where the action meaning is one-to-one and the existing accessible name remains unchanged.
- Do not remove `lucide-react` from `apps/web/package.json` in Phase 9 unless the final import audit proves it is unused and Phase 11 is reached.

## Canonical References

- `.planning/REQUIREMENTS.md` - `STATUS-01` through `STATUS-05`.
- `.planning/ROADMAP.md` - Phase 9 goal, success criteria, verification.
- `.planning/phases/08-layout-chrome-fonts-and-tabler-icons/08-ICON-AUDIT.md` - deferred domain icon imports.
- `AGENTS.md` - frontend conventions, QA gates, auditability discipline, sensitive-data restrictions.
- `docs/frontend-target.md` - context/view ownership, shared UI boundaries, testing expectations.
- `docs/local-reliability-qa.md` - local QA and accessibility bar.
- `apps/web/src/styles/globals.css` - global status selectors and shadcn semantic token usage.

## Code Context

### Existing Strong Patterns

- `stageStateTone`, `stageTone`, and `applyRunResultTone` already encode several lifecycle mappings with typed return values.
- `StageBadge`, `ApplyRunBadge`, `RunStatusBadge`, `ArtifactStatusBadge`, `ScoreBadge`, `ScoreBreakdown`, `TailoringExplanationSection`, `BulletProvenanceList`, and `EmployerAnalysisPanel` are context-owned semantic surfaces.
- `TailoringExplanationSection` already labels missing audit data, residual warnings, voice-pass lifecycle, per-bullet provenance, and adversarial audit details explicitly.
- `every-stage-state-has-badge.test.tsx` exists and should remain the canonical stage-state parity test.

### Risky Spots Found

- `StatusDot` currently concatenates arbitrary `state` into CSS classes.
- `SegmentBar` currently builds arbitrary `seg-*` classes from caller-provided names.
- `stateTone`, `artifactStatusTone`, `scoreTier`, and timeline/debug helpers return generic `string` in some places.
- Dashboard KPI tones are untyped string values.
- Discovery source tone helpers are local and typed, but not exported or directly covered as a variant contract.
- Remaining domain lucide imports live in apply-review, pipeline, scoring, discovery, materials, and profile components.

## Safety Notes

- No auto-apply, browser submission, mailbox scanning, real material generation, destructive profile/database actions, worker-backed jobs, or sensitive artifact/log exposure.
- Browser proof must use seeded/synthetic app data only.
- Do not suppress existing warning or missing-data UI as a substitute for computing/persisting correct audit facts.

