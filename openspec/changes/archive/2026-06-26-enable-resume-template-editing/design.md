## Context

JobHunter now renders current resume PDFs from generated HTML/CSS and reviews that same source through a Plate-backed surface. The existing renderer has the right invariant for final artifacts: `TailorResumeUseCase final_payload -> ResumeDocument + ResumeTheme -> ResumePrintHtml -> resume_pdf + sibling HTML + layout boxes`. The current Plate implementation is still mostly review/draft oriented, and profile-level `resume_template_text` remains a legacy LaTeX-shaped compatibility field rather than the target model for HTML/CSS templates.

The new feature adds reusable resume templates on top of that renderer. A template is not candidate data. It is a local style/layout object that can be previewed with profile data, selected globally, overridden per job, and snapshotted into generated materials. Template changes should not eagerly regenerate the user's whole backlog, but they also should not require manual re-tailoring before a user sees current materials. The product behavior should be lazy render-only regeneration when a current resume artifact is demanded.

## Goals / Non-Goals

**Goals:**

- Add a local resume template library with named templates and versioned edits.
- Represent templates as constrained `ResumeTheme` tokens plus optional safe Plate layout metadata, not arbitrary executable CSS.
- Let Preferences choose the default template and let each job choose an override.
- Preview and edit templates using the user's profile data without persisting profile facts into template records.
- Resolve and snapshot the effective template for every generated materials generation.
- Detect template drift and mark current materials as template-stale without bulk regeneration.
- Lazily render-refresh stale materials when current materials are needed by Apply Review, apply readiness, or artifact-open flows.
- Preserve the previous accepted artifacts until the lazy replacement generation succeeds.

**Non-Goals:**

- No collaborative editing or remote document storage.
- No arbitrary HTML/CSS/JavaScript template execution.
- No automatic profile mutation from template edits.
- No re-tailoring when a render-only refresh can reuse the last accepted resume content/document.
- No removal of legacy LaTeX artifact compatibility in this change.

## Decisions

### Decision: Add `ResumeTemplate` as its own Profile-owned configuration aggregate

Store templates in local SQLite tables such as `resume_templates` and `resume_template_versions`, with a stable template id, version id/number, display name, status, structured theme JSON, constrained Plate layout JSON, created/updated timestamps, and safe preview metadata. Store the default assignment in profile/settings-owned configuration and per-job assignments in a small job-scoped assignment table.

This keeps template data separate from `candidate_profiles`, avoids overloading the legacy `resume_template_text`, and makes version drift queryable. The Profile context owns user defaults and template authoring; Materials owns render application and artifact snapshots.

Alternatives considered:

- Reuse `candidate_profiles.resume_template_text`: rejected because it is LaTeX-shaped compatibility data and encourages string-template editing instead of structured HTML/CSS theme tokens.
- Store template choice only in `job_events`: rejected because render selection must be queryable for readiness, stale detection, and audit.
- Put template fields directly on `jobs`: rejected because template history, defaults, and assignment metadata need versioned ownership beyond the core discovery job row.

### Decision: Treat templates as data, not arbitrary CSS

Template editing should expose bounded controls: page size, margins, font family choices, font scale, density, header layout, section heading style, section ordering/visibility, bullet spacing, and alignment. Plate may provide the editing surface, but the persisted template model should be normalized to safe theme/layout data before save.

The renderer should generate CSS from those tokens. Any Plate document saved for template layout should use an allowlisted resume node schema with stable semantic slots, not raw profile text nodes as source of truth.

Alternatives considered:

- Save freeform CSS from the editor: rejected for safety, preview/final drift, and long-term maintainability.
- Save a full profile-populated Plate document as the template: rejected because profile facts could leak into template data and because templates should be reusable across jobs/profiles.

### Decision: Resolve effective template at material generation boundaries

Material generation resolves the effective template with this order:

1. Per-job template assignment.
2. User default template assignment.
3. Built-in default template.

The selected template id, version, theme hash, and assignment source are recorded in `job_materials.metadata_json`, `job_materials_artifacts.metadata_json`, and/or first-class projection columns. The final PDF and sibling HTML must both be generated from the same resolved template version.

Alternatives considered:

- Let the frontend choose template data and submit it with each render: rejected because the worker and API need a shared server-side source of truth.
- Resolve only at preview time: rejected because final artifacts must remain auditable and reproducible.

### Decision: Lazy render-only regeneration for template drift

When a template version, default assignment, or per-job assignment changes, the system records drift for affected current materials but does not eagerly create replacement artifacts. Current surfaces expose the state as `template_current`, `template_stale`, `refresh_queued`, `refresh_failed`, or equivalent.

When a flow needs current materials, it calls an ensure-current-materials path. If the latest accepted resume content/document exists and only the template is stale, the system creates a render-only replacement generation:

```text
latest accepted resume content/document
  + effective template version
  -> ResumePrintHtml
  -> Playwright PDF
  -> sibling HTML
  -> layout boxes
  -> new Materials generation
```

The old accepted generation stays active and visible until the replacement generation is fully written. Failed refresh attempts are audit history and do not destroy or hide the current reviewable artifact.

Alternatives considered:

- Eagerly regenerate all affected jobs on template save: rejected because template edits could trigger expensive local work across a large backlog.
- Require manual re-tailor/re-generate after template changes: rejected because users expect current materials when browsing to Apply Review or apply readiness.
- Mutate the existing artifact in place: rejected because artifact history and Apply Review auditability rely on immutable generations.

### Decision: Apply Review ensures current template rendering before draft creation

Apply Review should request or perform the ensure-current-materials step before creating a new resume review draft. If a stale resume can be lazily refreshed, the draft should be based on the refreshed generation. If refresh fails, Apply Review keeps showing the last accepted final file and reports the refresh problem without creating a draft that pretends stale materials are current.

Existing drafts tied to a prior generation remain inspectable as history. A new template-refreshed generation requires a new draft or explicit carry-forward decision so edits do not silently apply to the wrong visual artifact.

## Risks / Trade-offs

- Template preview could persist profile facts into template storage -> save only normalized theme/layout data and add sentinel tests proving profile text is absent from template rows.
- Lazy refresh could be slow when entering Apply Review -> expose queued/in-progress state, keep the old accepted file available, and use SSE invalidation after completion.
- Render-only refresh may be impossible for old text-only or legacy LaTeX materials -> fall back to a clear `refresh_unavailable` state with a manual re-tailor or legacy migration action.
- Template assignment changes may affect many jobs -> use indexed drift selectors and avoid unbounded scans in request handlers.
- New template metadata could drift from projections -> add API/projection parity tests for effective template fields and stale state.
- Plate editing could exceed safe template constraints -> normalize and validate saved template data server-side before versioning.

## Migration Plan

1. Add tables for templates, versions, default assignment, per-job assignments, and refresh attempts/stale state.
2. Seed a built-in default template that matches the current HTML/CSS renderer as closely as possible.
3. Backfill current materials with a nullable or built-in template snapshot so old artifacts remain readable.
4. Keep `resume_template_text` as legacy compatibility data during the transition; do not use it as the primary HTML/CSS template model.
5. Add lazy refresh behind API/worker seams first, then wire Apply Review, apply readiness, and artifact-open flows to ensure current materials.
6. Rollback by keeping old accepted artifacts as active and disabling lazy refresh/assignment UI; template rows can remain inert local data.

## Open Questions

- Should applying a new default template mark all active tailored jobs stale immediately, or compute default-template drift lazily from template snapshot hashes at read time?
- Which surfaces should trigger ensure-current-materials beyond Apply Review, apply readiness, and opening a resume artifact?
- Should users be able to pin a job to "built-in default" to ignore future default-template changes?
- How much section ordering should v1 expose before it becomes content strategy rather than style/layout?
