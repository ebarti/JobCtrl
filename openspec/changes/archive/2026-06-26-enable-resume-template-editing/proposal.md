## Why

JobHunter can already render HTML/CSS resume artifacts through Plate-backed review surfaces, but users cannot define reusable resume templates or choose which template a job should use. Template edits also need to update current materials lazily when those materials are actually needed, instead of forcing expensive bulk regeneration or requiring users to remember manual re-tailoring.

## What Changes

- Introduce a local resume template library with named templates, versions, structured `ResumeTheme` tokens, and a constrained Plate-backed editing surface.
- Allow users to configure a default resume template in Preferences.
- Allow users to select a per-job resume template override that wins over the default.
- Render template previews with the user's profile data as sample content without persisting profile facts into template records.
- Resolve the effective template for material generation as: per-job override, then user default, then built-in default.
- Mark affected materials template-stale when a template or assignment changes, without eagerly regenerating all affected jobs.
- Lazily refresh stale materials when current materials are needed, such as opening Apply Review, checking apply readiness, or opening the current resume artifact.
- Make lazy refresh render-only when possible: reuse the last accepted resume content/document, apply the effective template version, reprint PDF/HTML, recompute layout boxes, and create a new auditable materials generation.
- Keep previous accepted artifacts visible until the lazy replacement generation succeeds.
- Snapshot the effective template id, template version, and theme hash into generated material metadata and projections.

## Capabilities

### New Capabilities

- `resume-template-editing`: Manage local resume templates, default template selection, per-job overrides, effective-template resolution, and lazy template-driven material refresh.

### Modified Capabilities

- `resume-review-drafts`: Apply Review must resolve template-stale materials before creating or restoring a review draft, while preserving prior accepted artifacts if lazy refresh fails.

## Impact

- TypeScript API contracts and SQLite schema for resume templates, template versions, default selection, per-job assignments, stale markers, and lazy refresh endpoints or actions.
- Python Materials renderer and repository code for effective-template resolution, render-only regeneration, metadata snapshots, and layout-box refresh.
- React Profile/Preferences, Jobs, Apply Review, and Materials surfaces for template editing, assignment, stale state, and lazy refresh progress.
- Operations projections and SSE invalidation so Jobs, Artifacts, and Apply Review show current template status without disrupting active review.
- Tests across API, worker renderer/repository, web components/hooks, Apply Review flows, and browser QA for template preview/editing and lazy regeneration.
