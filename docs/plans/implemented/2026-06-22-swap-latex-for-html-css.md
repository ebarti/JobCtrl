# Swap LaTeX For HTML/CSS Resume Rendering

> **Status:** Complete in PR #188.
>
> **Change ID:** `swap-latex-for-html-css`
>
> This plan replaces the default resume rendering path from LaTeX/`pdflatex`
> to HTML/CSS printed by Playwright, and updates Apply Review to use the same
> generated HTML source through a Plate-backed review surface.

> **For agentic workers:** This is not yet the full Google Docs-like resume
> editor. The current PR intentionally uses Plate as the resume document shell
> for faithful review rendering, line selection, links, and deterministic
> JobHunter audit annotations. A persisted, user-editable Plate document model
> is the next phase.

## Goal

Swap resume PDF generation and Apply Review resume inspection to a single
HTML/CSS source of truth. The resume must look like the final file when reviewed,
without using a PDF image/iframe overlay for current HTML-rendered artifacts.

The implemented product invariant is:

```text
TailorResumeUseCase final_payload
  -> ResumeDocument + ResumeTheme
  -> sanitized HTML/CSS resume with layout targets
  -> Playwright prints the final resume_pdf
  -> sibling generated HTML is stored next to the final PDF
  -> layout boxes are persisted and projected
  -> Apply Review fetches the sibling HTML
  -> Plate renders that same resume source with JobHunter annotations
```

The final submit artifact is still a PDF. The important change is that the
review surface and final PDF now come from the same HTML/CSS render source.

## Problem

Before this PR, the final visual artifact came from `LatexPdfAdapter`, while
Apply Review tried to map audit lines back onto the rendered PDF in the browser:

- The Materials renderer compiled a `moderncv` LaTeX template with `pdflatex`.
- The accepted text artifact and the PDF artifact were sibling artifacts in the
  same `MaterialsSet` generation.
- Apply Review derived line targets from `materialsPreview.resumeText`, asked
  PDF rendering/text extraction for page geometry, and overlaid controls on PDF
  page images.
- Poppler still rendered page PNGs for stable PDF-page images in the local API.

That preserved the final PDF visually, but made line-level review depend on
fuzzy text matching, PDF text grouping, LaTeX wrapping, and browser-side
geometry reconciliation. It also made a richer resume editing/review experience
clunky because comments and selections lived beside or above the PDF instead of
inside the resume document model.

## Non-Goals

- Do not build collaborative editing, suggestion mode, arbitrary rich-text
  formatting, or persisted user-authored comment threads in this PR.
- Do not replace the required `resume_pdf` artifact for apply readiness,
  cover generation, or final submission.
- Do not show an HTML approximation that is generated separately from the final
  PDF source. Apply Review must use the generated HTML/CSS that prints the final
  PDF for current HTML-rendered artifacts.
- Do not store raw profile payloads, raw prompts, generated PDFs, local paths,
  or application data in committed fixtures.
- Do not remove legacy LaTeX compatibility. Historical or explicitly configured
  LaTeX artifacts remain supported through the legacy renderer path.

## Implemented Change

The PR implements an HTML/CSS resume renderer in the Materials bounded context:

- `HtmlResumePdfAdapter` lives beside `LatexPdfAdapter` and is now the default
  `PdfRendererPort` resume implementation.
- The renderer consumes the same final tailored payload and profile snapshot as
  the old LaTeX renderer.
- It builds a structured resume document, renders sanitized HTML/CSS, prints the
  final PDF through Playwright, and returns the existing
  `ArtifactType.RESUME_PDF` with `RenderFormat.HTML_PDF`.
- The legacy LaTeX path remains opt-in with
  `JOBHUNTER_RESUME_RENDERER=latex_pdf`.
- The generated HTML is stored as a sibling file next to the final PDF and is
  available through `GET /v1/artifacts/:artifactId/preview.html`.
- Layout boxes are persisted in `job_material_layout_boxes`, projected onto
  artifact read models as `layout_boxes_json`, and included in Apply Review
  materials preview data as `resumePdfLayoutBoxes`.
- A migration command moves existing approved resume artifacts onto the same
  HTML/CSS source path:
  `uv --project workers/automation run jobhunter migrate-resume-html`
  with `--dry-run`, `--force`, `--job-url`, and `--limit`.

The resume visual style was also brought back toward the old LaTeX output:

- A4 page geometry with compact margins.
- Monochrome black text and rules.
- A cleaner Avenir/Aptos-oriented font stack.
- Centered header with phone, email, website, and LinkedIn icons/links.
- Real hyperlinks for `tel:`, `mailto:`, and `https` contact targets.
- Moderncv-like experience headings with company/location on the first row and
  title/date on the second row.
- Real list bullets without duplicate bullet markers.
- Section rules and compact entry grids that preserve the resume content layout
  more closely than a plain-text reconstruction.

## Plate Scope

The current Plate implementation is a review surface, not yet the full editor:

- `ResumePlateEditor` fetches the generated HTML preview for the selected final
  resume PDF.
- The generated HTML is parsed into a Plate value using custom resume block and
  inline elements.
- Custom Plate renderers preserve safe resume tags, classes, line metadata, and
  safe links.
- Selecting a resume line updates the Apply Review selected-line state.
- JobHunter-authored audit annotations are rendered as non-editable note bubbles
  inside the Plate-rendered resume surface.

"JobHunter comments" in this PR means deterministic audit annotations derived
from existing provenance, source fields, grounding, and risk data. They are not
Plate's collaborative comment plugin, not user-authored comment threads, and not
persisted rich-text comments.

The next phase can promote this from a review shell into a full Plate editor by
making the Plate document value the saved editable draft, adding editing
controls, serializing changes back to a reviewed Materials generation, reprinting
through the same HTML/CSS renderer, and re-running audit/readiness checks before
approval.

## Target Ubiquitous Language

**ResumeDocument** (Value Object)
- Definition: The canonical structured source for one generated resume.
- Owner: Materials Generation.
- Shape: personal header, summary, experience entries, education entries, skill
  groups, and generated bullets with stable semantic IDs.
- Invariants: Claim-bearing lines should have provenance, requirement links, or
  an explicit missing-provenance state.

**ResumeTheme** (Value Object)
- Definition: Structured style tokens for resume rendering.
- Owner: Candidate Profile for defaults; Materials snapshots the values used for
  each generated artifact.
- Shape: paper size, margins, font family, font sizes, section spacing, header
  style, and density.
- Invariants: Theme tokens are data, not arbitrary executable CSS.

**ResumePrintHtml** (Rendered Document)
- Definition: The trusted generated HTML/CSS representation produced from a
  `ResumeDocument` and `ResumeTheme`.
- Owner: Materials renderer adapter.
- Invariants: Generated from structured data only; sanitized before persistence
  and browser rendering; used to print the final PDF and to feed Apply Review.

**ResumeLayoutBox** (Read Model / Artifact Companion)
- Definition: Generation-time page and bounding-box metadata for selectable
  resume audit targets.
- Owner: Materials Generation, projected through Operations.
- Shape: artifact ID, generation, page number, semantic ID, line number, text
  excerpt, left/top/width/height percentages, and source/audit target metadata.
- Invariants: Computed from the final HTML/CSS render path, not
  reverse-engineered from PDF text extraction for current artifacts.

**Plate Resume Review Surface** (Frontend Review Model)
- Definition: The Apply Review component that renders generated resume HTML as
  a Plate document and overlays deterministic JobHunter audit annotations.
- Owner: Materials frontend context, composed by Apply Review.
- Invariants: The rendered content is the generated resume HTML for the selected
  final PDF artifact; comments are derived from audit/provenance data.

## Implemented Rendering Flow

```text
TailorResumeUseCase
  -> produces final voiced payload
  -> builds ResumeDocument with semantic IDs
  -> writes tailored_resume text for compatibility and plain-text audit
  -> HtmlResumePdfAdapter renders sanitized resume HTML/CSS
  -> Playwright prints the same HTML source to resume_pdf
  -> renderer records layout boxes and sibling HTML
  -> MaterialsSet.with_resume_pdf approves the PDF artifact
  -> layout boxes project to artifact_list_projections.layout_boxes_json
  -> API serves preview.pdf, preview.html, and layout boxes
  -> Apply Review renders preview.html through Plate
  -> JobHunter audit annotations appear on selected resume lines
```

## Apply Review Changes

Apply Review now uses the selected final resume PDF artifact to locate the
generated sibling HTML preview:

- Current HTML-rendered artifacts fetch `/v1/artifacts/:artifactId/preview.html`
  and render it through `ResumePlateEditor`.
- The "open final file" link still opens `/preview.pdf` for the final artifact.
- Line-level review is rendered inside the resume surface, not as a separate
  side-by-side audit rail.
- JobHunter annotations show source text, rationale, source precision,
  grounding/risk labels when provenance exists, and explicit missing-provenance
  states.
- Safe resume links remain clickable in the Plate surface.
- Legacy LaTeX artifacts that have not been migrated are treated as legacy
  preview states; current HTML-rendered artifacts should not fall back to a PDF
  image overlay.

## Data And Persistence

The implementation uses three durable pieces of artifact state:

- The final PDF artifact remains the canonical `resume_pdf` apply artifact.
- The sibling generated HTML file is stored next to the PDF and served only for
  `render_format = 'html_pdf'` resume artifacts.
- `job_material_layout_boxes` stores layout targets outside artifact metadata.
  Python and TypeScript projection builders include those boxes in
  `artifact_list_projections.layout_boxes_json`.

The API exposes:

- `GET /v1/artifacts/:artifactId/preview.pdf` for the final PDF artifact.
- `GET /v1/artifacts/:artifactId/preview.html` for generated HTML/CSS resume
  artifacts.
- `resumePdfLayoutBoxes` on Apply Review materials preview data.

Legacy migration writes a temporary refreshed PDF/HTML pair, validates the PDF
header before replacement, updates the artifact `render_format` to `html_pdf`
when migrating legacy rows, refreshes layout boxes, and keeps rollback data for
safe replacement.

## Acceptance Criteria

- New generated resume PDFs can be produced without `pdflatex`.
- The produced artifact is still `ArtifactType.RESUME_PDF`, with
  `RenderFormat.HTML_PDF`.
- Apply readiness, cover generation, and auto-apply continue to require a real
  resume PDF artifact.
- Apply Review uses generated HTML/CSS through Plate for current HTML-rendered
  resume artifacts.
- The reviewed resume content and final PDF come from the same generated
  HTML/CSS source.
- JobHunter review annotations render inside the resume surface, written by
  "JobHunter", rather than in a separate side-by-side pane.
- Generated layout boxes are canonical/projection-backed and covered by Python
  and TypeScript projection tests.
- Legacy LaTeX artifacts remain readable and can be migrated or refreshed with
  the scoped migration command.
- No committed fixture contains real profile data, resumes, generated PDFs, raw
  prompts, local artifact paths, or application data.

## QA Gates

Required automated coverage:

- Python renderer tests for sanitization, HTML escaping, render-format tagging,
  layout-target metadata, Playwright PDF output, and layout-map emission.
- Materials repository tests proving layout boxes are persisted outside artifact
  metadata.
- Legacy migration tests for dry-run, force refresh, scoped migration, rollback,
  PDF validation, and layout-box refresh.
- Python and TypeScript projection tests for `layout_boxes_json`.
- API tests for artifact detail, `/preview.html`, and Apply Review materials
  preview layout boxes.
- Apply Review component tests for Plate rendering, line selection, JobHunter
  annotations, safe links, legacy preview states, and no PDF-overlay regression
  for current artifacts.
- Browser smoke on `/apply-review` against a real local HTML-rendered resume
  artifact before relying on tests alone.

Required visual checks:

- Verify the rendered resume uses the generated HTML/CSS surface, not a PDF page
  image or iframe.
- Verify the first page keeps the LaTeX-like content layout: A4 page, centered
  header, black section rules, compact entry grids, moderncv-like experience
  rows, and real list bullets.
- Verify contact icons are present, contact links are real hyperlinks, and all
  resume colors are monochrome black.
- Verify selecting a resume line highlights the Plate-rendered line and shows
  at most one JobHunter annotation beside it.
- Verify the "open final file" link opens the generated PDF artifact.
- Verify PDF export opens in common viewers and remains ATS-friendly enough for
  text extraction.

Validation already run for PR #188:

- `git diff --check`
- `uv --project workers/automation run --extra dev ruff check workers/automation/src/jobhunter/infrastructure/materials/html_resume_pdf.py workers/automation/src/jobhunter/infrastructure/materials/resume_html_migration.py workers/automation/tests/test_pdf_renderer_ports.py workers/automation/tests/test_resume_html_migration.py`
- `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_pdf_renderer_ports.py workers/automation/tests/test_resume_html_migration.py`
- `corepack pnpm --filter @jobhunter/web test -- ApplyReviewView.test.tsx resume-preview-style.test.ts`
- `corepack pnpm web:check`
- `corepack pnpm api:check`
- `corepack pnpm test`
- Live browser verification on `/apply-review`.

## Risks

- Chromium print layout can drift from screen layout. The renderer must keep
  print and review tied to the same generated HTML/CSS source and regression
  test the CSS used by the review surface.
- CSS fragmentation can split dense resumes in ways that are hard to map back to
  semantic IDs. Layout boxes and line targets reduce this risk, but dense resume
  pagination still needs visual QA.
- HTML/CSS can become arbitrary styling if theme controls are not tokenized.
  Keep resume style as structured `ResumeTheme` data.
- PDF text extraction may differ from LaTeX and could affect ATS parsing. Keep
  extraction checks in renderer QA before removing legacy compatibility.
- Legacy custom LaTeX templates may not have a one-to-one migration path. Treat
  them as compatibility input, not as the target editing model.
- Turning the Plate shell into a full editor creates new product invariants:
  edits must become a new auditable Materials generation, not an untracked
  mutation of an approved final artifact.

## Follow-Up: Full Plate Editor

The next implementation step is to turn the Plate review shell into a real
resume editor:

- Define the canonical Plate document schema for generated resumes.
- Persist editable drafts separately from approved final artifacts.
- Add editing controls that preserve resume-theme constraints instead of
  arbitrary CSS.
- Serialize edits back through the HTML/CSS renderer.
- Reprint the PDF from the edited document.
- Re-run grounding, provenance, keyword coverage, layout, and readiness checks
  before an edited artifact can replace the accepted one.
- Decide whether user-authored comments use Plate's comments plugin, a local
  JobHunter comment model, or both.

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
