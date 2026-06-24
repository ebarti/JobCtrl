## 1. Contracts And Persistence

- [ ] 1.1 Add contract types and Zod schemas for resume review drafts, draft revisions, edit deltas, comment threads, comment replies, and feedback signals.
- [ ] 1.2 Add local SQLite tables and migrations for draft lifecycle data, comment lifecycle data, and append-only feedback signals.
- [ ] 1.3 Add API client methods and ports for creating/loading drafts, saving revisions, replying to comments, and listing feedback signals.
- [ ] 1.4 Add API tests proving draft rows reference the selected base artifacts and never mutate approved materials in place.

## 2. Draft Creation And Revision Save

- [ ] 2.1 Add a Materials-owned service for creating or loading a draft from the selected Apply Review materials generation.
- [ ] 2.2 Implement draft revision save with structured edit-delta extraction against the prior revision or base material.
- [ ] 2.3 Restore the latest saved draft when reopening Apply Review for a job with an existing draft.
- [ ] 2.4 Add tests for autosave/manual save, dirty state persistence, and draft reload behavior.

## 3. Live Plate Resume Editor

- [ ] 3.1 Add the documented Plate packages needed for editable resume content, comments, history, and serialization after verifying exact package names.
- [ ] 3.2 Refactor the current generated HTML Plate surface into a controlled editor that can load base HTML or a saved draft value.
- [ ] 3.3 Preserve semantic ids, line/page anchors, source pins, risk labels, and the final-file link while editing.
- [ ] 3.4 Block Apply Review approval controls when the selected resume draft is dirty, invalid, or not rendered into replacement artifacts.
- [ ] 3.5 Add component and route tests for editing a generated claim line, editing a structural line, save state, and approval blocking.

## 4. Comment Threads And Replies

- [ ] 4.1 Seed persisted comment threads from JobHunter audit pins and risk labels when the selected material has audit data.
- [ ] 4.2 Add UI for replying to a JobHunter line comment without suppressing the original source pointer or risk label.
- [ ] 4.3 Persist reply body or structured decision with thread id, draft revision id, author, timestamp, and bounded text.
- [ ] 4.4 Track comment lifecycle states for open, user-replied, resolved, superseded-by-edit, and residual-after-acceptance.
- [ ] 4.5 Add tests proving comment anchors survive draft revisions and unresolved anchors are shown honestly.

## 5. Validation, Rendering, And Promotion

- [ ] 5.1 Convert saved draft content into the structured resume document or tailored payload shape used by Materials validation and rendering.
- [ ] 5.2 Validate edited content for structural integrity, unsupported claims, provenance risk, banned words, and renderer compatibility.
- [ ] 5.3 Render edited candidates through the HTML/CSS resume renderer, persist replacement HTML/PDF artifacts, and regenerate layout boxes.
- [ ] 5.4 Promote only validated and rendered edited candidates; keep the last accepted materials visible until replacement approval succeeds.
- [ ] 5.5 Add Python and API tests for validation failure, render failure, successful promotion, and layout-box projection.

## 6. Feedback Capture (Machine Learning Deferred)

- [ ] 6.1 Tag saved edit deltas with deterministic/manual feedback signal kinds such as style preference, factual correction, claim-policy correction, keyword strategy, and provenance dispute.
- [ ] 6.2 Tag comment replies as feedback signals while preserving the original JobHunter comment and audit context.
- [ ] 6.3 Add a reviewable feedback read model that can later feed writing-style controls, profile correction suggestions, or tailoring policy changes.
- [ ] 6.4 Ensure feedback signals are append-only and do not silently mutate profile data, tailoring policy, prompts, model routing, or model behavior.
- [ ] 6.5 Document that model training, fine-tuning, machine-learning inference for feedback classification, automatic prompt adaptation, and automatic policy/profile mutation are deferred to a later proposal.
- [ ] 6.6 Add tests proving feedback projections use safe identifiers and bounded excerpts only, and that extracting feedback does not trigger model/prompt/policy mutation.

## 7. Documentation And QA

- [ ] 7.1 Update README, local TypeScript API docs, architecture docs, frontend target docs, and local reliability QA docs for the new draft/edit/comment/learning lifecycle.
- [ ] 7.2 Add or update Apply Review Vitest coverage, API persistence tests, Python materials tests, and MSW fixtures for the new editor path.
- [ ] 7.3 Add browser QA for `/apply-review` covering edit, save, comment reply, validation block, successful replacement render, and final-file link behavior.
- [ ] 7.4 Run the relevant verification set: `pnpm api:test`, `pnpm web:check`, `pnpm --filter @jobhunter/web test`, focused Python materials tests, `git diff --check`, and a browser smoke path.
