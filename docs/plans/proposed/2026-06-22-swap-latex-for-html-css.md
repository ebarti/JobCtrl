# Swap LaTeX For HTML/CSS Resume Rendering

> **Status:** Implemented in this PR.
>
> **Change ID:** `swap-latex-for-html-css`
>
> This plan replaces the resume rendering path from LaTeX/`pdflatex` to
> HTML/CSS printed by Playwright while preserving the current Apply Review audit
> contract.

> **For agentic workers:** This is not a request to build a generic document
> editor. Keep the implementation inside the Materials bounded context, keep PDF
> as the final submit artifact, and retain LaTeX only as an explicit
> compatibility renderer.

## Goal

Swap resume PDF generation to an HTML/CSS print renderer that can produce both
the final PDF and stable audit layout metadata from the same semantic resume
document.

The product invariant is:

```text
canonical resume document
  -> HTML/CSS print layout
  -> PDF artifact for submission
  -> generation-time line and claim layout map
  -> Apply Review highlights the exact final PDF
```

## Problem

The current resume path produces the final visual artifact through
`LatexPdfAdapter`, while Apply Review maps audit lines back onto the rendered PDF
in the browser:

- The Materials renderer compiles a `moderncv` LaTeX template with `pdflatex`.
- The accepted text artifact and the PDF artifact are sibling artifacts in the
  same `MaterialsSet` generation.
- Apply Review derives line targets from `materialsPreview.resumeText`, asks
  pdf.js for PDF text geometry, and overlays transparent buttons on PDF page
  images.
- Poppler still renders page PNGs for stable PDF-page images in the local API.

This keeps the user inspecting the final PDF, which is correct, but the line
highlight layer is inferred from PDF text extraction after rendering. That makes
auditable line-by-line review depend on fuzzy text matching, PDF text grouping,
LaTeX wrapping, and browser-side geometry reconciliation.

## Non-Goals

- Do not build a Google Docs-like editor as part of this renderer migration.
- Do not introduce collaborative editing, comments, suggestion mode, or arbitrary
  rich-text formatting.
- Do not make Apply Review show a separate HTML approximation instead of the
  final PDF.
- Do not store raw profile payloads, raw prompts, generated PDFs, or local paths
  in committed fixtures.
- Do not break existing LaTeX-generated artifacts; historical artifacts remain
  inspectable.

## Proposed Change

Use a structured `ResumeDocument` plus tokenized `ResumeTheme` as the renderer
input, produce paginated HTML/CSS, print that HTML through Playwright, and persist
layout boxes generated from the same final DOM used for PDF export.

The user-facing contract stays the same:

- `resume_pdf` remains the artifact required for cover generation and apply
  readiness.
- Apply Review still shows the final tailored PDF, not a rendered HTML
  approximation.
- Existing LaTeX-rendered artifacts remain readable and selectable through the
  current legacy PDF text-geometry fallback.
- `RenderFormat.HTML_PDF` identifies new resume PDFs rendered through the
  Playwright path.

## Target Ubiquitous Language

**ResumeDocument** (Value Object)
- Definition: The canonical structured source for one generated resume.
- Owner: Materials Generation.
- Shape: personal header, summary, experience entries, education entries, skill
  groups, and generated bullets with stable semantic IDs.
- Invariants: Every generated claim-bearing line has provenance, requirement
  links, or an explicit missing-provenance state.

**ResumeTheme** (Value Object)
- Definition: User-controlled style tokens for resume rendering.
- Owner: Candidate Profile for defaults; Materials snapshots the values used for
  each generated artifact.
- Shape: paper size, margins, font family, font sizes, section spacing, accent
  color, density, header style.
- Invariants: Theme tokens are data, not arbitrary executable CSS.

**ResumePrintHtml** (Rendered Document)
- Definition: The trusted HTML/CSS representation produced from a
  `ResumeDocument` and `ResumeTheme`.
- Owner: Materials renderer adapter.
- Invariants: Generated from structured data only; no raw user-authored HTML.

**ResumeLayoutMap** (Read Model / Artifact Companion)
- Definition: Generation-time page and bounding-box metadata for selectable
  resume audit targets.
- Owner: Materials Generation, projected through Operations.
- Shape: artifact ID, generation, page number, semantic ID, resume line number,
  text excerpt, left/top/width/height percentages, source/audit target IDs.
- Invariants: Computed from the same final DOM used to print the PDF, not
  reverse-engineered from PDF text extraction.

## Target Rendering Flow

```text
TailorResumeUseCase
  -> produces final voiced payload
  -> builds ResumeDocument with semantic IDs
  -> writes tailored_resume text for compatibility and plain-text audit
  -> HtmlResumePdfAdapter renders paginated HTML
  -> Playwright prints the same HTML to resume_pdf
  -> renderer records ResumeLayoutMap
  -> MaterialsSet.with_resume_pdf approves the PDF artifact
  -> PdfRendered and layout-map projection invalidations refresh the UI
```

## Current Spec Sync (2026-06-22)

The implementation now exists locally:

- `HtmlResumePdfAdapter` lives beside `LatexPdfAdapter` in the Materials
  infrastructure package.
- It consumes the same tailored payload and profile snapshot shape as the LaTeX
  adapter, builds a structured resume document, renders sanitized print HTML,
  prints it through Playwright, and returns an `ArtifactType.RESUME_PDF` with
  `RenderFormat.HTML_PDF`.
- It is the default tailoring renderer. The legacy LaTeX path remains available
  with `JOBHUNTER_RESUME_RENDERER=latex_pdf`.
- Renderer tests cover structured document construction, HTML escaping, layout
  target attributes, render-format tagging, and layout metadata.
- Layout boxes are persisted in canonical Materials rows, projected by Python
  and TypeScript builders, served by API/read-model contracts, and consumed by
  Apply Review when available.

## Renderer Design

The implementation adds an `HtmlResumePdfAdapter` beside the legacy
`LatexPdfAdapter`.

The adapter should:

- Consume the same final tailored payload and profile snapshot currently passed
  to the LaTeX renderer.
- Build a typed `ResumeDocument` before rendering.
- Render sanitized HTML from components/templates owned by the worker package.
- Use fixed page containers in the DOM, not an unconstrained webpage, so the
  browser layout tree is also the layout source of truth.
- Use print CSS with explicit `@page` size and zero Playwright margins, then
  print with `preferCSSPageSize: true` and `printBackground: true`.
- Use `print-color-adjust: exact` plus the WebKit-prefixed equivalent where the
  theme relies on subtle backgrounds or accent colors.
- Return the existing `ArtifactType.RESUME_PDF` with
  `RenderFormat.HTML_PDF`; do not add a new artifact role for HTML-rendered
  resume PDFs.

The implementation uses explicit letter page sizing, stable layout targets, and
page-relative box extraction for audit lines. A future pagination-hardening pass
can replace browser-native fragmentation with deterministic page containers if
visual QA exposes unstable page breaks on dense resumes.

Suggested pagination approach:

1. Render semantic blocks into an offscreen Playwright page using print styles.
2. Measure block heights against the selected page size and margins.
3. Compose explicit `.resume-page` containers.
4. Move whole blocks first; split only bullet lists and long bullet text when
   needed.
5. Emit layout boxes from the final page DOM using `getBoundingClientRect()`
   relative to each page container.
6. Print that final paginated DOM to PDF.

## Apply Review Changes

Apply Review should keep showing the tailored PDF as the visual resume surface.
The change is how selectable targets are found:

- Prefer `ResumeLayoutMap` boxes when the selected PDF has them.
- Fall back to the current pdf.js text-geometry matcher for legacy LaTeX PDFs and
  old artifacts without a layout map.
- Keep `resumeTextArtifactId` as the audit artifact for provenance when present.
- Keep explicit missing-provenance states; do not hide lines that lack audit data.
- Add UI copy only for lifecycle states, not for implementation details.

This preserves the existing local QA rule that Apply Review uses the tailored
PDF as the selectable resume audit surface and avoids reintroducing a separate
HTML approximation.

## Data And Persistence

Avoid putting layout-map truth only in `metadata_json`. Use canonical rows or a
canonical JSON projection source that both Python and TypeScript projection
builders can reproduce.

Candidate table:

```sql
CREATE TABLE job_material_layout_boxes (
  tenant_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  artifact_id TEXT NOT NULL,
  semantic_id TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  line_number INTEGER,
  text_excerpt TEXT NOT NULL,
  left_pct REAL NOT NULL,
  top_pct REAL NOT NULL,
  width_pct REAL NOT NULL,
  height_pct REAL NOT NULL,
  audit_target_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, job_id, generation, artifact_id, semantic_id)
);
```

Projection requirements:

- Artifact detail exposes layout boxes for PDF artifacts when present.
- Apply Review queue can include a compact layout-map availability flag, but
  should fetch full boxes through artifact detail or a dedicated route if the
  payload becomes large.
- Python and TypeScript projection parity fixtures include one HTML-rendered
  resume PDF with layout boxes.

## Migration Plan

### PR 1: Renderer Seam And Fixture

- Add `HtmlResumePdfAdapter` behind the existing `PdfRendererPort`.
- Switch tailoring to default to `HtmlResumePdfAdapter`.
- Add a synthetic profile/job fixture and a renderer contract test that produces:
  text artifact, HTML-rendered PDF artifact, and layout boxes.
- Assert the artifact remains `resume_pdf` and the render format is `html_pdf`.

### PR 2: Layout Map Persistence

- Add canonical layout-map persistence in the Materials context.
- Project layout boxes through Python and TypeScript projection builders.
- Add parity coverage using synthetic data only.
- Keep current Apply Review behavior unchanged.

### PR 3: Apply Review Uses Layout Boxes

- Add frontend/API contract fields for PDF layout boxes.
- Update `PdfAuditPreviewViewer` to use layout boxes when available.
- Keep the pdf.js text matcher as a legacy fallback.
- Add Apply Review tests proving HTML-rendered PDFs do not need fuzzy text
  matching to highlight a provenance-linked line.

### PR 4: Default HTML Resume Renderer

- Switch the default renderer to `html_pdf`.
- Keep LaTeX as a compatibility renderer for historical custom-template users
  through `JOBHUNTER_RESUME_RENDERER=latex_pdf`.
- Update README, architecture docs, local QA docs, and setup diagnostics.

## Acceptance Criteria

- New generated resume PDFs can be produced without `pdflatex`.
- The produced artifact is still `ArtifactType.RESUME_PDF`, with
  `RenderFormat.HTML_PDF`.
- Apply readiness, cover generation, and auto-apply continue to require a real
  resume PDF artifact.
- Apply Review uses generated layout boxes for new HTML-rendered resume PDFs and
  still falls back to the current pdf.js matching path for old LaTeX artifacts.
- Generated layout boxes are canonical/projection-backed and covered by Python
  plus TypeScript projection parity tests.
- No committed fixture contains real profile data, resumes, generated PDFs, raw
  prompts, local artifact paths, or application data.

## QA Gates

Required automated coverage:

- Python renderer unit tests for sanitization, pagination, render-format tagging,
  and layout-map emission.
- Materials aggregate/use-case tests proving HTML resume PDFs preserve the
  `resume_pdf` invariant and publish `PdfRendered`.
- Projection parity tests for layout-map rows.
- API tests for artifact detail / preview responses with layout boxes.
- Apply Review component tests for layout-map selection and legacy fallback.
- Browser smoke on `/apply-review` with a seeded HTML-rendered PDF artifact.

Required visual checks:

- Render the same synthetic resume through LaTeX and HTML during rollout and
  compare high-level layout: one-page fit, section order, heading
  hierarchy, bullet wrapping, spacing, and contact header.
- Verify the selected Apply Review line highlights the exact PDF pixels of the
  selected generated claim.
- Verify PDF export opens in common viewers and remains ATS-friendly enough for
  text extraction.

## Risks

- Chromium print layout may not match normal screen layout. The renderer must
  measure and print the same final paginated DOM.
- CSS fragmentation can split content in ways that are hard to map back to
  semantic IDs. Explicit page containers reduce this risk.
- HTML/CSS can become arbitrary styling if theme controls are not tokenized.
  Keep resume style as structured `ResumeTheme` data.
- PDF text extraction may differ from LaTeX and could affect ATS parsing. Add a
  synthetic extraction regression before switching defaults.
- Existing custom LaTeX templates may not have a one-to-one migration path.
  Treat them as compatibility input, not as the target editing model.

## Open Questions

- Should `ResumeDocument` be persisted as its own artifact companion, or can it
  be reconstructed from the accepted tailored payload plus provenance rows?
- Should layout boxes be served on artifact detail or through a dedicated
  `/v1/artifacts/:artifactId/layout` endpoint?
- How much of the current resume style schema maps cleanly to `ResumeTheme`, and
  which LaTeX-only knobs should be deprecated?
- Is ATS parsing parity good enough with Chromium PDFs, or do we need a separate
  text-layer validation step?
- Should manual user edits be modeled as a new Materials generation immediately,
  or saved as a draft generation that must pass audit before approval?

## Reference Notes

- [Playwright `page.pdf()`](https://playwright.dev/docs/api/class-page#page-pdf)
  uses print CSS media by default and supports CSS-sized PDF output; use CSS page
  sizing deliberately rather than relying on viewport layout.
- [MDN printing guidance](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Media_queries/Printing)
  documents `@media print` and `@page` as the browser-native way to control
  print-specific layout and page dimensions.
- [MDN `print-color-adjust`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/print-color-adjust)
  is useful for output fidelity but still subject to user-agent behavior.
- Modern CSS layout guidance favors intrinsic sizing, grid/flex for stable
  composition, and explicit overflow handling. For print resumes, use those
  primitives inside fixed page containers instead of viewport-responsive layout.
