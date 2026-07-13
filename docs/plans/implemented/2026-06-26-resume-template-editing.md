# Resume Template Editing And Lazy Material Refresh

- **Status:** Implemented / archived 2026-06-26. Delivered end to end by #193.
- **Date:** 2026-06-26
- **Owning bounded contexts:** Profile, Materials, Apply, and Operations
- **Source:** Consolidated on 2026-07-12 from the delivered OpenSpec proposal,
  design, capability requirements, and completed task record.

## 1. Outcome

JobCtrl has a local, versioned resume-template library with a built-in default,
user-selected default, and per-job override. Templates contain constrained
style/layout data rather than candidate facts or arbitrary executable CSS.
Every generated materials generation snapshots the effective template id,
version, hash, and assignment source.

Changing a template or assignment marks affected materials stale without
eagerly re-tailoring the backlog. When a flow needs current materials, JobCtrl
reuses the last accepted structured resume content where possible, applies the
current effective template, renders replacement HTML/PDF artifacts, recomputes
layout boxes, and promotes the new generation only after the complete render
succeeds.

## 2. Scope And Non-Goals

### In scope

- Named local templates and immutable template versions.
- Structured `ResumeTheme` tokens and constrained Plate layout controls.
- Preferences default selection and job-scoped overrides.
- Profile-data previews that never persist profile facts into template rows.
- Effective-template resolution at material-generation boundaries.
- Template snapshots on materials and artifact read models.
- Indexed stale-state detection and render-only lazy refresh.
- Apply Review, apply-readiness, and current-artifact flows that ensure current
  rendering while preserving the prior accepted artifact on failure.

### Non-goals

- Collaborative editing or remote template storage.
- Arbitrary HTML, CSS, JavaScript, local paths, or profile/job facts in template
  payloads.
- Automatic profile mutation from template edits.
- Re-tailoring when a safe render-only refresh can reuse accepted content.
- Eager bulk regeneration after every template change.

The original delivery retained readable legacy `latex_pdf` history. The live
LaTeX renderer was later removed by #367; historical format values remain a
migration/read concern, not an active template-rendering path.

## 3. Architecture Decisions

### 3.1 `ResumeTemplate` is a Profile-owned configuration aggregate

Profile owns template authoring and the user default. Materials owns applying a
resolved version and snapshotting it into an artifact generation. Per-job
assignments are queryable job-scoped records rather than event-only state or
fields overloaded onto discovery jobs.

Template records contain stable ids, immutable versions, display metadata,
normalized theme/layout JSON, timestamps, and safe preview metadata. They do
not reuse the old LaTeX-shaped profile template string.

### 3.2 Templates are bounded data

The editor exposes a constrained set of page, margin, font, density, heading,
spacing, ordering/visibility, and alignment controls. Server-side validation
normalizes allowlisted theme/layout data before creating a version. The renderer
generates print CSS from those tokens; user-supplied executable CSS or arbitrary
markup is rejected.

### 3.3 Effective template resolution is deterministic

Resolution order is:

1. per-job template assignment;
2. user default template assignment;
3. built-in default template.

The selected id, version, hash, and assignment source are recorded with both
materials and artifacts so preview, final PDF, audit, and later drift checks use
the same source of truth.

### 3.4 Drift triggers lazy render-only replacement

A template version or assignment change records or derives template drift. It
does not mutate the accepted artifact or immediately regenerate every job.
Current-material consumers invoke the ensure-current-materials path:

```text
last accepted structured resume content
  + current effective template version
  -> normalized print HTML
  -> Playwright PDF + sibling HTML
  -> layout boxes
  -> replacement materials generation
```

The old accepted generation remains current until the replacement is fully
written. Failures and unavailable render-only migrations are explicit audit
states, not destructive transitions.

### 3.5 Apply Review refreshes before creating a new draft

Apply Review ensures current template rendering before it creates a draft from
stale materials. If refresh succeeds, the new draft is tied to the refreshed
generation. If refresh fails, the prior final file remains visible and no draft
pretends that stale materials are current. Historical drafts stay bound to
their original generations.

## 4. Delivered Product Contract

### 4.1 Template records and editing

- Saving creates a new version instead of mutating an existing version.
- Persisted template data contains normalized style/layout settings and no
  profile facts, job facts, executable content, or local paths.
- Unsupported markup or tokens fail server-side validation.
- A built-in default always resolves when no user default exists.

### 4.2 Selection and audit

- The user default applies unless a job override exists.
- A job override wins deterministically and the inherited/default state is
  visible in the UI.
- New materials snapshot template id, version, hash, and assignment source.
- Job, artifact, and Apply Review read models expose current/stale/refreshing/
  failed/unavailable status without duplicating a second template authority.

### 4.3 Staleness and refresh

- Changing a default or job override makes affected accepted materials stale
  without eager regeneration.
- Apply Review, apply readiness, and current resume artifact access ensure
  current materials before treating them as current.
- Render-only refresh reuses accepted resume content and never invokes the
  tailoring generator or changes claims.
- A successful refresh creates a new generation with matching HTML, PDF, and
  layout-box template metadata.
- A failed or unavailable refresh preserves the last accepted generation and
  final-file link.
- If render-only refresh is unavailable because the accepted source is missing
  or legacy-only, the UI reports `refresh_unavailable` and presents an explicit
  migration or re-tailor action instead of silently changing resume content.

## 5. Implementation Record

| Phase | Delivered behavior |
| --- | --- |
| Data model | Template/version/default/override contracts, SQLite storage, built-in default, resolution helpers |
| API and projections | Template CRUD/version routes, assignment endpoints, payload validation, status fields, domain events, invalidation parity |
| Renderer | `ResumeTheme` normalization, one effective version for HTML/PDF/layout boxes, metadata snapshots, renderer/repository tests |
| Lazy refresh | Ensure-current service, render-only replacement, failure audit, previous-artifact preservation, current-material entry points |
| Frontend | Preferences template library/editor/default, job override, status surfaces, Apply Review refresh handoff |
| Documentation and QA | User/API/architecture/QA updates, API/web/Python checks, disposable-workspace browser QA |

## 6. Delivery Evidence And Residual Boundary

The #193 delivery recorded:

- TypeScript API and web checks;
- full web unit/component coverage;
- focused API template, draft, feedback, server, and workflow tests;
- focused Python renderer and Materials use-case tests;
- Ruff on the touched Python surfaces;
- browser QA for Preferences editing/default selection, Apply Review job
  overrides, lazy-refresh gating, and HTML preview parity; and
- `git diff --check`.

The handoff recorded that its browser backend could not capture the requested
mobile screenshot and ignored a viewport override. That was a QA evidence gap
in the original delivery, not a hidden claim that mobile visual QA had passed.
Later frontend regression coverage and product QA own the current responsive
bar.
