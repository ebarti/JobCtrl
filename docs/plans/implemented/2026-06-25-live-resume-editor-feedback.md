# Live Resume Editor, Review Comments, And Feedback Capture

- **Status:** Implemented / archived 2026-06-25. Delivered by #190 and #191;
  the completed requirements were synchronized and archived by #192.
- **Date:** 2026-06-25
- **Owning bounded contexts:** Materials, Apply, Profile, and Operations
- **Source:** Consolidated on 2026-07-12 from the delivered OpenSpec proposal,
  design, capability requirements, and completed task record.

## 1. Outcome

Apply Review uses the generated HTML/CSS resume as a live Plate editing surface.
The user can edit tailored content, save and reload versioned draft revisions,
reply to JobCtrl-authored line comments, validate and render a replacement, and
approve only a current rendered candidate. Profile uses the same Plate-backed
HTML/CSS editing direction instead of a separate LaTeX preview path.

The delivery preserves the audit boundary:

- a draft is derived from one exact materials generation and never mutates an
  accepted artifact in place;
- edits are stored as structured deltas against the base artifact or prior
  revision;
- comment threads retain source pins, risk labels, anchors, and lifecycle state;
- validation and HTML/PDF rendering create a reviewable replacement candidate,
  not an implicitly accepted artifact;
- the last accepted artifact remains current and visible until explicit
  replacement approval succeeds; and
- edits and replies produce append-only, reviewable feedback signals, not
  automatic profile, prompt, policy, routing, training, or model changes.

## 2. Scope And Non-Goals

### In scope

- Versioned resume review drafts derived from approved materials.
- A controlled Plate editor that restores saved content and preserves semantic
  ids, line/page anchors, source pins, risk labels, and the final-file link.
- Autosave/manual save, dirty state, revision reload, formatting controls,
  stable typing, layout preservation, and undo history.
- Persisted JobCtrl comment threads and bounded user replies.
- Server-side draft conversion, deterministic validation, replacement
  HTML/PDF rendering, layout-box regeneration, and candidate promotion.
- Deterministic/manual feedback classification and a safe reviewable read model.

### Non-goals

- Real-time multi-user collaboration.
- Editing an approved PDF in place.
- Treating arbitrary editor HTML as the canonical approved domain document.
- Automatically mutating the candidate profile, tailoring policy, prompts, or
  model behavior from unreviewed edits.
- Model training, fine-tuning, feedback-classification inference, or automatic
  prompt/model-routing adaptation.
- Exposing raw profiles, raw job text, local paths, generated PDFs, browser
  data, logs, or database contents through broad events or projections.

## 3. Architecture Decisions

### 3.1 Materials owns editable drafts

`ResumeReviewDraft` belongs to Materials because an edited resume must re-enter
validation, rendering, artifact registration, layout-box persistence, and the
materials readiness lifecycle. Apply continues to own approve, dry-run,
submit, defer, decline, and reset decisions.

Keeping drafts only in view state was rejected because it would make the
browser editor an unaudited source of truth for a domain artifact.

### 3.2 Drafts are versioned against immutable base artifacts

Each draft records the job, materials generation, source text artifact, source
PDF artifact, renderer format, and latest revision. Revisions store structured
edit deltas with semantic ids, anchors, before/after text, and timestamps. A
saved Plate value restores the UI, while server-side conversion reconstructs
the structured material consumed by validators and renderers.

### 3.3 Comments are persisted review threads

Audit pins and risk labels seed stable JobCtrl-authored threads. Replies attach
to those threads without replacing the original source pointer or risk label.
Thread states distinguish open, user-replied, resolved, superseded-by-edit, and
residual-after-acceptance outcomes. Broken anchors are reported honestly rather
than silently remapped.

### 3.4 Save is not promotion

Saving a draft records work in progress. Promotion converts the latest saved
revision into a structured candidate, checks structure, unsupported claims,
provenance risk, banned language, and renderer compatibility, then writes new
HTML/PDF artifacts and layout boxes as a reviewable candidate. The last
accepted artifact remains current until that candidate is explicitly approved.
Approval remains blocked while the draft is dirty, invalid, unrendered, or not
the selected replacement candidate.

### 3.5 Feedback is append-only and gated

Meaningful saved deltas and comment replies create `TailoringFeedbackSignal`
rows. Signals may describe style preference, factual correction, claim-policy
correction, keyword strategy, provenance dispute, or requested wording. They
remain reviewable inputs for future work; no signal silently changes durable
profile facts or generation authority.

## 4. Delivered Product Contract

### 4.1 Draft lifecycle

- Opening Apply Review for editable HTML materials creates or restores a draft
  tied to the selected approved generation.
- Reopening restores the latest saved revision and its audit anchors.
- Saving persists the Plate document plus structured deltas against the prior
  revision or base material.
- Existing drafts remain tied to their base generation; later material changes
  do not silently rebase them.
- A failed validation or render attempt keeps the prior accepted generation
  available and records the failed attempt as audit history.

### 4.2 Editor behavior

- Tailored and structural lines are editable without remounting the editor or
  dropping focus after each keystroke.
- Bold, italic, underline, font family, font size, and left/center/right
  alignment controls are accessible.
- Experience/company indentation and semantic resume layout survive edits.
- Ctrl+Z/Cmd+Z restores recent content and formatting changes.
- The Profile baseline resume uses the Plate HTML/CSS editor; it does not use a
  Profile-level LaTeX renderer branch.

### 4.3 Comment and reply behavior

- JobCtrl comments persist with stable ids, source pins, risk labels, semantic
  anchors, and bounded excerpts.
- Users can explain a dispute, request wording, or accept a comment without
  suppressing the original audit context.
- Replies persist the author, timestamp, thread id, draft revision id when
  known, and a bounded body or structured decision.
- Revisions preserve or explicitly invalidate anchors.
- Resolution, supersession by edit, and residual-after-acceptance states remain
  inspectable.
- Events and projections carry safe ids and bounded excerpts only.

### 4.4 Validation, rendering, and approval

- A saved revision must convert to the structured resume representation used by
  Materials validation and rendering.
- Unsupported structure, fabricated/unsupported claims, provenance failures,
  banned language, and renderer incompatibility fail closed.
- A valid draft produces replacement HTML and PDF artifacts plus regenerated
  layout boxes in a new materials generation.
- Apply approval cannot proceed from unsaved or unrendered editor state.
- A successfully validated and rendered replacement remains a reviewable
  candidate; only explicit replacement approval makes its artifacts current
  for readiness and final-file access. The prior accepted generation is not
  deleted.

### 4.5 Feedback capture

- Style edits, factual corrections, claim-policy corrections, keyword strategy
  changes, provenance disputes, and comment decisions can be tagged
  deterministically or manually.
- Every edit signal references the job, base materials generation, draft
  revision, affected resume section or anchor when known, and its
  deterministic/manual classification.
- Every reply signal preserves whether the user accepted, rejected, clarified,
  or requested a rewrite while retaining the original JobCtrl comment, source
  pin, warning/risk label, and audit context.
- Signals are append-only and linked to safe draft/revision/thread identifiers;
  if accepted into future writing-style or tailoring guidance, the originating
  feedback source remains visible in audit history.
- Feedback extraction does not invoke training, fine-tuning, inference-based
  classification, prompt mutation, model routing, or profile/policy mutation.

## 5. Implementation Record

| Phase | Delivered behavior |
| --- | --- |
| Contracts and persistence | Shared schemas, SQLite draft/revision/thread/reply/signal tables, API client methods, and artifact-reference tests |
| Draft creation and save | Materials-owned create/load, structured deltas, reload, autosave/manual-save, and dirty-state persistence |
| Plate editor | Controlled editor, audit-anchor preservation, approval blocking, stable typing, formatting, layout, and undo regressions |
| Comments and replies | Seeded JobCtrl threads, bounded replies, lifecycle states, anchor survival, and unresolved-anchor display |
| Promotion | Structured conversion, deterministic validation, replacement-candidate HTML/PDF rendering, layout boxes, explicit approval, and last-accepted preservation |
| Feedback | Deterministic/manual signal tags, safe projections, append-only behavior, and explicit ML deferral |
| Documentation and QA | User flow, API, architecture, frontend, QA, API/web/Python tests, and browser smoke coverage |

## 6. Delivery Evidence And Residual Boundary

Delivery validation recorded across #190 and #191 included API, web, contracts,
API-client, and focused Python materials checks, plus the Apply Review browser
path. The durable regression surfaces now include:

- `apps/api/test/resume-review-drafts.test.ts`
- `apps/api/test/server.test.ts`
- `apps/web/src/views/apply-review/ApplyReviewView.test.tsx`
- `apps/web/src/contexts/apply/hooks/useApplyReviewMutations.test.ts`
- `workers/automation/tests/test_materials_repository.py`

The machine-learning boundary remains deferred. Captured signals are audit and
future-policy inputs only; any automatic learning workflow requires a separate
design covering retention, evaluation, review, rollback, and safety.
