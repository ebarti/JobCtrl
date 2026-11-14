# Resumes

This feature owns composition, exact document provenance, staged edits, advisory
review, acceptance, presentation templates, comments, translations and exports.
`bootstrap.build_feature` registers its real HTTP and durable application entry
points. It consumes only the public Profile, Requirements and Fit services. All
canonical writes and invalidation events share the foundation SQLite writer.

## Composition authority

Profile supplies the complete ordered authored role/achievement inventory and
approved wording revisions. Requirements supplies current `requirements-v2`
canonical Skills and Professional Experience IDs. Education and Language demands
remain outside achievement selection. Fit supplies persisted, source-bound coverage relations; a missing
relation stays unknown/uncovered. Resumes performs no meaning judgment and does
not write a person score.

For every achievement exactly one approved variant is chosen. The exact dynamic
program gives each eligible canonical requirement one internal policy point.
It first maximizes distinct covered requirements, then complementary supports
from distinct achievements. The second objective is total achievement support
points minus the first
objective. The final tie break is the ordered tuple of variant IDs/revisions.
Guaranteed coverage is factored out of the choice graph; independent components
use ranked backpointers and cached arithmetic. The finite structural admission
limits are 50,000 states, 200,000 paths and 1,000,000 transitions; an irreducible
case refuses explicitly with recorded work counts and preserves accepted output.
Cancellation is checked during expansion. There is no beam, approximate result,
brevity penalty, role omission or polish loop. The manifest retains all chosen IDs, exact Fit determination IDs, coverage
relations, arithmetic objectives and uncovered requirement IDs.
The manifest records `requirements-v2` and composition policy
`requirement-wording-v2-equal`; unit coefficients are internal policy, never
importance attributed to a posting. Old operation receipts cannot resume as
this generation, and old tailored revisions visibly require refresh. Historical
accepted rows and bytes remain retained.
Current section-backed support stays in the manifest with
`wording_eligible=false` and its exact Fit source receipt. It has no achievement
wording gap and contributes no point to the achievement-selection objective.

The saved `resumeMode` policy defaults to `tailored`. `baseline` selects an exact
`baseline_copy` of authored wording. Baseline composition, explicit coherence
review requests, editing, rendering and acceptance make no resume model calls.
An explicitly requested locale translation is a separate model operation.

## Drafts and acceptance

Every edit or composition appends an immutable document revision. A draft can
retain freeform Plate changes while reporting mechanical approval failures.
`approve-edits` requires explicit user confirmation; it records the exact changed
achievement text through Profile in the same transaction and keeps the editor
content. Non-achievement fact edits go through Profile. Staged unapproved claims
cannot be accepted by overriding an advisory review.

One coherence determination reviews an assembled document. Its claim is committed
before model admission, with input fingerprint and source/version provenance.
Repeated requests do not call the model again. A durable retry can recover an
exact settled gateway receipt or report an interrupted/uncertain review honestly.
Review findings/failure/timeout and explicit user acceptance are separate records.
No automatic rewrite, qualification rescore or recursive repair is performed.

Acceptance requires a complete, exact approved/source-bound document, verified
rendered bytes, no explicit layout conflict, and a completed review attempt
(or baseline review marked not applicable). An explicit review override accepts a
mechanically valid document despite an advisory finding or unavailable review;
the original review status remains visible. Accepted PDF identity and bytes are
pinned independently of later draft edits, renders and failures.

After acceptance, freshness follows only the selected wording approvals and
selected factual/source authority. Unrelated new approved wording/achievements,
or refreshed Fit/Requirements records, do not remove a still-valid accepted PDF.
They produce separate library-outdated or coverage-stale notices. Revoking a
selected variant or changing/disputing a selected fact/source invalidates use;
the historical artifact remains available. Applications approves the current job
and exact payload independently through `accepted_snapshot` and
`validate_attachment`.

## Presentation and locale

The production HTML/CSS/fonts/Chromium and editable DOCX renderer implementations
were ported under this owner. Templates have immutable version histories and
saved defaults. Template Plate content transfers presentation by semantic ID;
it never supplies candidate claims. A4/Letter, font/density/margins, headings,
section order and editor formatting remain explicit choices. Sections cannot be
hidden. An explicit page limit produces a layout conflict rather than dropping
content. Profile previews return ephemeral verified PDF bytes and do not publish
unreferenced durable artifacts.

Every structured Profile Language/Proficiency row survives baseline composition,
HTML/Plate, text, verified PDF, DOCX and locale projection. Stable field IDs are
`language:<id>:language` and `language:<id>:proficiency`. Existing four-section
templates remain valid: rendering appends a nonempty Languages section without
rewriting the saved template. An empty Languages default changes neither the
baseline document projection nor earlier accepted artifacts. Selected language
sources participate in accepted-source freshness alongside Education and Skills.

Physical PDF source-text preservation is checked after rendering. Exact literal
per-page text binds page identities where unambiguous. Retained DOM coordinates
are explicitly labelled `continuous_dom`, with
`geometry_physical_verified: false`; they are not physical PDF glyph geometry.

PDF file creation records root/inode/hash ownership in SQLite before bytes are
written. Publication marks that file registered in the document transaction.
Job deletion queues minimum-metadata retirements without touching files until
the deletion commits. Post-commit cleanup uses native no-overwrite claims,
no-follow descriptor reads and exact inode/hash authority. Startup reconciles
interrupted unpublished files from their recorded ownership intent. Foreign
replacements, hard links, changed roots and unregistered UUID files are preserved;
cleanup failure remains pending and retryable. No directory-name guessing grants
deletion authority.

Locale generation translates every recorded field ID, including section labels.
Historical identity/title/credential/contact fields and literal achievement
values remain unchanged. Independent source-bound verification and explicit user
acceptance precede locale exports. Failed generation/rendering preserves the
accepted source and earlier accepted locale exports. These controlled-provider
checks do not establish real-model translation accuracy.

## Public paths and ports

- `GET/POST /v1/resumes` list/compose; mutations return `{ok, resume}`.
- `GET /v1/resumes/{resume_id}` reads the full revision/acceptance history.
- `POST /{resume_id}/edit`, `/approve-edits`, `/review`, `/render`, `/accept`,
  `/comments`, `/template` use the observed aggregate `expected_version`.
- `GET /{resume_id}/export?format=pdf|html|txt|docx` supports `accepted=true` and
  `revision_id` to pin historical output. PDF `artifact_id` selects the exact
  recorded render, including older rerenders and locale files. Draft HTML is
  available before acceptance.
- `POST /{resume_id}/artifacts/{artifact_id}/open` accepts only an empty body and
  requests native opening after exact owned-byte verification. The response says
  `requested`; it does not claim an independently observed visible application.
- `POST /v1/resume-artifact-retirements/cleanup` takes only recorded `job_ids` and
  retries committed retirement work; it cannot admit an arbitrary path.
- `GET /{resume_id}/locales`; `POST /locales/generate`,
  `/locales/{locale_id}/review`, `/accept`; `GET /export` retain locale history.
- `GET/POST /v1/resume-templates`, detail and `PATCH/POST /default` retain the
  existing template DTOs and source-version fences.
- Durable actions: `resumes.compose`, `resumes.render`, `resumes.review`,
  `resumes.locale_generate`, `resumes.locale_review`.
- `compose`, `render` and `review` accept bounded `operation_id` values. Exact
  input/result receipts are committed with canonical effects; changed-input reuse
  conflicts. Durable dispatch defaults to its run ID.
- Public readers: `accepted_snapshot`, `validate_attachment`,
  `interview_snapshot`, `assert_interview_current`, `digest_summary` and
  `preview_profile`. No consumer reads Resumes tables directly.

The renderer's optional `JOBCTRL_CHROMIUM_EXECUTABLE` selects the external browser
process boundary. It enables real-browser distribution configuration and owned
E2E launch-failure proof without a fake internal renderer.
