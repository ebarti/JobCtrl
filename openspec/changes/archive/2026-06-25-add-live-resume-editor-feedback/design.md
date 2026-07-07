## Context

Apply Review currently uses a Plate-backed HTML/CSS resume surface for line-level audit. The route selects a resume PDF artifact for final-file preview, fetches the generated sibling HTML for the Plate surface, and uses the tailored-resume text artifact for audit data when available. The current component parses generated HTML into custom Plate nodes, displays source-to-tailored pins, and shows JobCtl comments derived from canonical artifact projections.

The existing architecture is local-first, projection-backed, and audit-oriented. Materials Generation owns tailored resume artifacts, PDF rendering, provenance, coverage, voice, and layout boxes. Apply Automation owns the human review queue and apply decisions. Candidate Profile owns reusable profile data and tailoring policy. This change crosses those contexts, so the design has to preserve the current boundaries instead of treating the browser editor as a standalone source of truth.

## Goals / Non-Goals

**Goals:**

- Let the user edit the tailored resume directly in Apply Review through Plate.
- Persist draft revisions and edit deltas against the exact generated materials the user reviewed.
- Let the user reply to JobCtl's line comments and preserve those replies as audit and learning data.
- Validate, re-render, and approve edited resumes as new materials candidates or generations.
- Extract feedback signals from edits and replies without silently mutating profile data or global tailoring policy.
- Preserve the existing invariant that failed refreshes and replacements do not destroy the last accepted artifact.

**Non-Goals:**

- Real-time multi-user collaboration.
- Editing already approved PDF files in place.
- Replacing the HTML/CSS resume renderer or removing legacy migration behavior.
- Automatically rewriting the user's profile, tailoring policy, or global prompts from unreviewed feedback.
- Training or fine-tuning models, changing model routing, or automatically adapting prompts, profile data, or tailoring policy from captured feedback.
- Exposing raw profile payloads, raw job text, local paths, generated PDFs, or logs through events and projections.

## Decisions

### 1. Materials Generation owns editable resume drafts

`ResumeReviewDraft` belongs to Materials Generation because editing the resume changes the material artifact lifecycle. Apply Automation continues to own review decisions such as approve dry run, approve submit, defer, decline, and reset.

Alternative considered: store drafts as Apply Review UI state. That would be easier for the first editor but would blur ownership, because the edited resume has to re-enter validation, rendering, artifact registration, layout-box persistence, and materials readiness.

### 2. Drafts are versioned against base artifacts

Each draft records the base job id, materials generation, text artifact id, PDF artifact id, renderer format, and latest draft revision. Saved revisions store structured edit deltas against the base or previous revision. This keeps review evidence explainable even after a user edits a generated line.

Alternative considered: save the current HTML string only. That loses stable comparison points for feedback extraction and makes it harder to prove which generated claim the user changed.

### 3. Plate is the editing shell, not the only domain model

The web editor can persist a Plate document value for UI restoration, but the server-side material candidate should be reconstructed into the structured resume document or tailored payload shape that the renderer and validators understand. Arbitrary HTML should not become the canonical approved artifact source.

Alternative considered: accept sanitized edited HTML as the canonical resume source. That is faster, but it weakens renderer consistency, provenance mapping, keyword coverage, and PDF layout-box regeneration.

### 4. Comments become persisted review threads

JobCtl-authored comments should be seeded from audit pins and risk labels when data exists, then represented as review threads with stable ids and lifecycle state. User replies attach to those threads. UI-only comment bubbles are insufficient because replies need to drive learning and remain visible in audit history.

Alternative considered: use Plate comments only in editor state. That would support annotation UX but would not provide an auditable source of truth for learning or candidate validation.

### 5. Edited resumes promote through validation and rendering

Saving a draft does not approve it. Promotion validates the edited content, checks claim and provenance risk, renders replacement HTML/PDF artifacts, persists new layout boxes, and registers a new candidate or materials generation. The last accepted materials stay visible until the replacement is approved.

Alternative considered: enable apply approval from a dirty editor value. That would make it easy to apply with unrendered or unvalidated text that does not match the final file.

### 6. Feedback extraction is append-only and gated

Edit deltas and comment replies produce `TailoringFeedbackSignal` rows. These signals can later become writing-style guidance, profile correction suggestions, claim-policy changes, or prompt controls, but only after review or an explicit acceptance path. This matches the existing bias toward auditability and prevents unreviewed user edits from silently corrupting the profile baseline.

Alternative considered: immediately mutate profile or tailoring policy from every edit. That is risky because some edits are job-specific, some are copy preferences, and some are corrections to generated material rather than durable profile truth.

### 7. Machine learning is explicitly deferred

This change does not train, fine-tune, reroute, or otherwise adapt models from resume edits or comment replies. The first implementation should capture safe, reviewable feedback signals and may use deterministic/manual tags only. Any machine-learning, model-evaluation, or automatic prompt/policy adaptation workflow requires a later OpenSpec change with its own data-retention, audit, evaluation, and rollback design.

Alternative considered: classify feedback with a worker-backed model and immediately make accepted classes available to generation. That would expand the first editor milestone into model behavior, safety, evaluation, and data-governance work, which should not be coupled to the editing lifecycle.

## Risks / Trade-offs

- Editor state and renderer state can drift -> require a server-side conversion/validation step before promotion and test PDF output against edited source.
- Comment anchors can break after edits -> store semantic ids, line anchors, text hashes, and explicit unresolved-anchor states instead of pretending all comments still map cleanly.
- Feedback tagging can overgeneralize job-specific edits -> keep signals append-only and reviewable before applying them globally.
- Plate dependency surface can grow quickly -> add only documented packages needed for editing, comments, history, and serialization; verify exact package names before dependency changes.
- Autosave can create noisy revisions -> debounce autosave and derive feedback from meaningful saved revisions or explicit user actions.
- Sensitive data can leak through events -> events and projections must carry safe ids and bounded excerpts only.

## Migration Plan

1. Add local tables, contracts, API client methods, and read/write routes for draft creation, revision save, comment replies, and feedback signals.
2. Build a server-side draft-to-material conversion path that validates edited content before it can become a replacement candidate.
3. Upgrade the Apply Review Plate component from generated render surface to controlled editor, including dirty state, save state, comment threads, and approval blocking.
4. Add promotion flow that renders new HTML/PDF artifacts, regenerates layout boxes, and preserves the last accepted materials until approval.
5. Add feedback extraction and reviewable learning surfaces without model training, fine-tuning, routing changes, or automatic prompt/policy adaptation.
6. Update docs and QA gates for the new lifecycle.

Rollback strategy: because drafts and feedback are additive, rollback can hide the editor and ignore draft tables while continuing to serve the existing generated HTML/PDF Apply Review surface. Approved artifacts must remain registered through the existing materials tables.

## Open Questions

- Should the first implementation persist full Plate value, structured resume document, or both?
- Which feedback signal tags should be manually reviewable in the first UI surface?
- Should edited candidates create a new materials generation immediately, or remain draft candidates until explicit approval?
- How much comment UI should use Plate's comment plugin versus JobCtl-owned thread components?
