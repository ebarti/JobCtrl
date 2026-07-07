## Why

Apply Review currently renders the generated HTML/CSS resume through Plate for line-level audit, but the approved materials remain read-only from the user's perspective. Users need to edit the tailored resume directly in the review surface, respond to JobCtrl's line comments, and have those corrections feed future tailoring without silently mutating approved artifacts or weakening audit guarantees.

This matters now because Apply Review already has the generated HTML, PDF layout boxes, source-to-tailored claim pins, and inline JobCtrl comments in one place. The next step is to turn that audit surface into a controlled editing and learning workflow.

## What Changes

- Add a versioned resume review draft lifecycle derived from the selected generated materials generation.
- Replace the read-only Plate rendering path with a fully editable Plate resume editor that preserves line/page anchors, source pins, and the final-file link.
- Persist user edits as structured edit deltas against the base artifact, including semantic ids, line anchors, before/after text, and draft revisions.
- Allow users to respond to JobCtrl-authored comments on tailored lines without losing the underlying claim-risk and provenance audit.
- Convert accepted edits and comment replies into append-only feedback signals that can inform future tailoring, writing-style controls, profile evidence corrections, and claim-policy guidance.
- Defer machine learning, model training, fine-tuning, model-routing changes, and automatic prompt/policy adaptation; this change captures reviewable structured feedback only.
- Validate and re-render edited resumes as new materials candidates before approval; never mutate the last accepted artifact in place.
- Keep raw profile payloads, raw job text, local artifact paths, generated PDFs, and sensitive user data out of events, broad projections, telemetry, and PR-facing artifacts.

## Capabilities

### New Capabilities

- `resume-review-drafts`: Versioned Apply Review drafts for live Plate editing, validation, re-rendering, and promotion to new materials candidates.
- `resume-comment-replies`: Persisted user replies to JobCtrl line comments, tied to source pins, risk labels, and audit lifecycle state.
- `resume-edit-feedback-learning`: Append-only feedback extraction from user edits and comment replies for future tailoring and profile-policy improvements.

### Modified Capabilities

None. This repository does not yet have checked-in OpenSpec specs to modify.

## Impact

- Web: `apps/web/src/views/apply-review/`, `apps/web/src/contexts/materials/`, `apps/web/src/contexts/apply/`, Operations hooks/query keys, MSW fixtures, Plate plugin dependencies, and route/browser QA for `/apply-review`.
- API/contracts: `packages/contracts`, `packages/api-client`, `apps/api/src/application-feedback.ts`, artifact detail/read models, review draft routes, comment reply routes, and feedback-learning DTOs.
- Python/materials: resume HTML/CSS renderer, materials repository, layout-box persistence, provenance/coverage/voice audit handling, candidate validation, and deterministic/manual feedback tagging only.
- Data: new local SQLite tables for review drafts, draft revisions, edit deltas, comment threads/replies, and feedback signals.
- Documentation/QA: `README.md`, `docs/local-ts-api.md`, `docs/local-reliability-qa.md`, `docs/architecture.md`, and any Apply Review smoke/e2e coverage needed for the new editing lifecycle.
