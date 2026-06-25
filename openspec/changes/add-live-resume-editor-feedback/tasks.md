## 1. Contracts And Persistence

- [x] 1.1 Add contract types and Zod schemas for resume review drafts, draft revisions, edit deltas, comment threads, comment replies, and feedback signals.
- [x] 1.2 Add local SQLite tables and migrations for draft lifecycle data, comment lifecycle data, and append-only feedback signals.
- [x] 1.3 Add API client methods and ports for creating/loading drafts, saving revisions, replying to comments, and listing feedback signals.
- [x] 1.4 Add API tests proving draft rows reference the selected base artifacts and never mutate approved materials in place.

## 2. Draft Creation And Revision Save

- [x] 2.1 Add a Materials-owned service for creating or loading a draft from the selected Apply Review materials generation.
- [x] 2.2 Implement draft revision save with structured edit-delta extraction against the prior revision or base material.
- [x] 2.3 Restore the latest saved draft when reopening Apply Review for a job with an existing draft.
- [x] 2.4 Add tests for autosave/manual save, dirty state persistence, and draft reload behavior.

## 3. Live Plate Resume Editor

- [x] 3.1 Add the documented Plate packages needed for editable resume content, comments, history, and serialization after verifying exact package names. Verified the current `platejs@53.1.2` + `@platejs/basic-nodes@53.0.0` dependency set and lockfile-provided Plate core/runtime packages cover this slice without adding speculative package names.
- [x] 3.2 Refactor the current generated HTML Plate surface into a controlled editor that can load base HTML or a saved draft value.
- [x] 3.3 Preserve semantic ids, line/page anchors, source pins, risk labels, and the final-file link while editing.
- [x] 3.4 Block Apply Review approval controls when the selected resume draft is dirty, invalid, or not rendered into replacement artifacts.
- [x] 3.5 Add component and route tests for editing a generated claim line, editing a structural line, save state, and approval blocking.

## 4. Comment Threads And Replies

- [x] 4.1 Seed persisted comment threads from JobHunter audit pins and risk labels when the selected material has audit data.
- [x] 4.2 Add UI for replying to a JobHunter line comment without suppressing the original source pointer or risk label.
- [x] 4.3 Persist reply body or structured decision with thread id, draft revision id, author, timestamp, and bounded text.
- [x] 4.4 Track comment lifecycle states for open, user-replied, resolved, superseded-by-edit, and residual-after-acceptance.
- [x] 4.5 Add tests proving comment anchors survive draft revisions and unresolved anchors are shown honestly.

## 5. Validation, Rendering, And Promotion

- [x] 5.1 Convert saved draft content into the structured resume document or tailored payload shape used by Materials validation and rendering.
- [x] 5.2 Validate edited content for structural integrity, unsupported claims, provenance risk, banned words, and renderer compatibility.
- [x] 5.3 Render edited candidates through the HTML/CSS resume renderer, persist replacement HTML/PDF artifacts, and regenerate layout boxes.
- [x] 5.4 Promote only validated and rendered edited candidates; keep the last accepted materials visible until replacement approval succeeds.
- [x] 5.5 Add Python and API tests for validation failure, render failure, successful promotion, and layout-box projection.

## 6. Feedback Capture (Machine Learning Deferred)

- [x] 6.1 Tag saved edit deltas with deterministic/manual feedback signal kinds such as style preference, factual correction, claim-policy correction, keyword strategy, and provenance dispute.
- [x] 6.2 Tag comment replies as feedback signals while preserving the original JobHunter comment and audit context.
- [x] 6.3 Add a reviewable feedback read model that can later feed writing-style controls, profile correction suggestions, or tailoring policy changes.
- [x] 6.4 Ensure feedback signals are append-only and do not silently mutate profile data, tailoring policy, prompts, model routing, or model behavior.
- [x] 6.5 Document that model training, fine-tuning, machine-learning inference for feedback classification, automatic prompt adaptation, and automatic policy/profile mutation are deferred to a later proposal.
- [x] 6.6 Add tests proving feedback projections use safe identifiers and bounded excerpts only, and that extracting feedback does not trigger model/prompt/policy mutation.

## 7. Documentation And QA

- [x] 7.1 Update README, local TypeScript API docs, architecture docs, frontend target docs, and local reliability QA docs for the new draft/edit/comment/learning lifecycle.
- [x] 7.2 Add or update Apply Review Vitest coverage, API persistence tests, Python materials tests, and MSW fixtures for the new editor path.
- [x] 7.3 Add browser QA for `/apply-review` covering the live editor load, seeded comments, final-file link, and no visible API errors; edit/save, comment reply, validation block, and replacement render are covered by the route/API/Python test set to avoid mutating real local materials during handoff.
- [x] 7.4 Run the relevant verification set: `pnpm api:test`, `pnpm web:check`, `pnpm --filter @jobhunter/web test`, focused Python materials tests, `git diff --check`, and a browser smoke path.

## 8. Post-QA Regression Fixes

- [x] 8.1 Stabilize the live Plate editor so typing does not remount the editor, drop focus, or stop after each character.
- [x] 8.2 Add accessible resume formatting controls for bold, italic, underline, font family, font size, and left, center, and right alignment.
- [x] 8.3 Preserve resume entry layout and indentation when editing experience/company lines, and keep Ctrl+Z/Cmd+Z undo history functional for text and formatting edits.
- [x] 8.4 Render the Profile baseline resume through the Plate HTML/CSS editor, remove the Profile PDF iframe path, and remove the Profile-level LaTeX renderer branch.
- [x] 8.5 Add regression coverage and documentation/QA notes for the editor typing controls, entry-layout preservation, Profile Plate editor, and profile preview renderer alignment.
