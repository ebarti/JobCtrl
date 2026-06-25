## 1. Setup And Data Model

- [ ] 1.1 Confirm implementation is running from a dedicated worktree and not directly on `main`.
- [ ] 1.2 Add shared contract types and Zod schemas for resume templates, template versions, default template selection, per-job assignment, template status, stale state, and lazy refresh results.
- [ ] 1.3 Add SQLite migrations for `resume_templates`, `resume_template_versions`, default template assignment, per-job template assignment, and template refresh attempts or equivalent indexed stale-state support.
- [ ] 1.4 Seed a built-in default template that matches the current HTML/CSS resume renderer output and can be resolved when no user default exists.
- [ ] 1.5 Add repository helpers for creating template versions, listing templates, reading active template versions, setting defaults, setting per-job overrides, and resolving effective templates.

## 2. API And Projection Surfaces

- [ ] 2.1 Add TypeScript API endpoints for template list/detail/create-version/default-selection and per-job assignment updates.
- [ ] 2.2 Add API validation that rejects unsupported template markup, executable content, local paths, and profile/job facts in persisted template payloads.
- [ ] 2.3 Add read-model fields for effective template metadata and template-stale status on job detail, artifact detail/list, and Apply Review materials preview surfaces.
- [ ] 2.4 Add domain events and invalidation-router coverage for template version changes, default assignment changes, per-job assignment changes, and lazy refresh completion/failure.
- [ ] 2.5 Update API tests for template CRUD, default/override resolution, stale-state projection, and profile-fact sentinel isolation.

## 3. Renderer And Materials Integration

- [ ] 3.1 Introduce a `ResumeTheme` normalization layer for the HTML/CSS renderer that converts template tokens into safe print CSS.
- [ ] 3.2 Update `HtmlResumePdfAdapter` to accept an effective template/theme while preserving the same HTML source for final PDF and Plate preview.
- [ ] 3.3 Snapshot template id, template version, template hash, and assignment source into `job_materials` and resume artifact metadata for every new generation.
- [ ] 3.4 Add renderer/repository tests proving generated PDF, sibling HTML, and layout boxes all use the same effective template version.
- [ ] 3.5 Keep legacy LaTeX compatibility readable and ensure legacy-only artifacts report refresh unavailable instead of being silently mutated.

## 4. Lazy Refresh Flow

- [ ] 4.1 Add an ensure-current-materials service that compares latest accepted material template snapshots against the current effective template.
- [ ] 4.2 Implement render-only lazy refresh that reuses the last accepted resume content/document, applies the current effective template, writes a new materials generation, and recomputes layout boxes.
- [ ] 4.3 Ensure lazy refresh never calls the tailoring generator, changes claim text, mutates profile data, or hides the prior accepted artifacts before replacement success.
- [ ] 4.4 Record refresh queued, completed, failed, and unavailable states as audit history with safe metadata.
- [ ] 4.5 Wire Apply Review, apply readiness, and current resume artifact-open flows to ensure current materials before treating a resume as current.
- [ ] 4.6 Add failure-path tests proving stale accepted artifacts remain visible and no current draft is created from a failed refresh.

## 5. Frontend Experience

- [ ] 5.1 Add Profile/Preferences UI for browsing templates, editing a template with Plate-backed constrained controls, previewing with profile data, and choosing the default template.
- [ ] 5.2 Add job-level template selection controls in the job detail or Apply Review flow, including a visible inherited-default state.
- [ ] 5.3 Show template current/stale/refreshing/failed/unavailable status in Jobs, Artifacts, and Apply Review where current materials are displayed.
- [ ] 5.4 Update Apply Review to request or observe lazy refresh before draft creation and to keep the previous final-file link available while refresh is pending.
- [ ] 5.5 Add frontend tests for default selection, per-job override, stale status rendering, lazy-refresh handoff, and template-save profile-fact isolation.

## 6. Documentation And QA

- [ ] 6.1 Update `README.md`, `docs/local-ts-api.md`, `docs/architecture.md`, and `docs/frontend-target.md` for template editing, assignment, effective-template resolution, and lazy regeneration behavior.
- [ ] 6.2 Update `docs/local-reliability-qa.md` with regression rows for template editing, profile-data isolation, per-job override precedence, render-only lazy refresh, and Apply Review draft gating.
- [ ] 6.3 Run targeted API, worker, and web tests for the changed surfaces.
- [ ] 6.4 Run `pnpm api:check`, `pnpm web:check`, `pnpm --filter @jobhunter/web test`, and relevant Python tests for renderer/materials changes.
- [ ] 6.5 Browser-QA `/preferences`, the job template override flow, `/apply-review` lazy refresh, and final PDF/HTML preview parity against a seeded HTML-rendered resume.
- [ ] 6.6 Document any skipped verification with a concrete reason before requesting implementation review.
