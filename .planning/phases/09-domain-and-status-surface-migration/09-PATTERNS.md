---
phase: 09-domain-and-status-surface-migration
mapped: 2026-06-10T12:51:53Z
status: complete
---

# Phase 09 Pattern Map

## Tone Helper Pattern

Use closed string unions and `Record<DomainState, Tone>` maps where the domain type is closed. Use `assertNever` for switch statements over closed union types.

Examples:

- `apps/web/src/contexts/pipeline/lib/stage-state-tone.ts`
- `apps/web/src/contexts/pipeline/lib/stage-tone.ts`
- `apps/web/src/contexts/apply/lib/apply-run-tone.ts`

## Component Styling Pattern

Components render semantic text and a narrow class vocabulary:

- `tag ok|warn|danger|info|muted`
- `stage-pill neutral|info|ok`
- `fit good|mid|none`
- `status-dot succeeded|failed|blocked|running|queued|pending|skipped|stale|canceled|exhausted`
- `seg-done|seg-failed|seg-blocked|seg-running|seg-pending`
- `tone-info|tone-success|tone-warning|tone-danger|tone-muted`

Do not introduce unscannable Tailwind utilities or global CSS variables from context code.

## Audit Surface Pattern

Audit surfaces must render explicit missing states:

- `ArtifactTailoringInspector` renders loading/error/empty states.
- `TailoringExplanationSection` renders residual warnings, warning-repair state, missing generation audit data, and voice-pass lifecycle labels.
- `BulletProvenanceList` renders missing original bullets, empty FK sets, and empty provenance.
- `EmployerAnalysisPanel` renders missing evidence spans and ensemble failure details.

Phase 9 should preserve these behaviors and add tests only where the status mapping changes.

## Icon Pattern

Use `@tabler/icons-react` for visible domain controls where the action mapping is direct:

- play/run: `IconPlayerPlay`
- refresh/rescore: `IconRefresh`
- reset/undo stale score: `IconRotateClockwise`
- check/approve: `IconCheck`
- plus/add: `IconPlus`
- trash/delete: `IconTrash`
- external link/open: `IconExternalLink`
- alert/quarantine: `IconAlertTriangle`, `IconBan`
- preview/import/feedback/close: `IconEye`, `IconUpload`, `IconThumbUp`, `IconX`
- generate/tailor: `IconSparkles`

Keep existing button text, titles, `aria-label`s, and disabled behavior.

