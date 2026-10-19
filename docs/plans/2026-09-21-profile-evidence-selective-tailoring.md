# Profile Evidence And Selective Resume Composition

> **Status:** Proposed, unshipped, and awaiting explicit user approval.
> Merging this plan records a reviewable design; it does not authorize the
> implementation slices below or change existing profile, import, Tailor, or
> artifact behavior.
>
> **Intake design:** [#1013](https://github.com/ebarti/JobCtrl/issues/1013) owns
> the multi-source investigation in sections 2, 4 and 8. This is a docs-only
> design checkpoint, not a shipped intake or reconciliation capability.
>
> **Program owner:** [#883](https://github.com/ebarti/JobCtrl/issues/883). Optional
> downstream aids [#902](https://github.com/ebarti/JobCtrl/issues/902) and
> [#903](https://github.com/ebarti/JobCtrl/issues/903) do not replace this
> program.

## 1. Outcome And Boundaries

The program separates the candidate's exhaustive evidence inventory from a
job-specific, deliberately selective resume. It must let a user:

1. capture facts and unresolved questions in a private draft;
2. review and explicitly promote supported facts into a versioned canonical
   Candidate Profile;
3. build a per-job Resume Brief from that canonical evidence;
4. choose an Executive or Staff/Principal narrative lens without changing the
   underlying facts;
5. select and compress evidence within configurable artifact budgets; and
6. inspect why evidence was selected, omitted, compressed, or rejected in the
   actual shipped text, HTML, and PDF.

The Candidate Profile remains the only authority for candidate facts.
Generated materials, job descriptions, model responses, interview drafts, and
rendered artifacts never become profile evidence by implication.

This plan does not choose universal role, bullet, word, page, or skill limits.
It defines structural measurements and model-authority checks needed before
choosing configurable defaults. It does not
run interviews, rewrite existing profiles, re-tailor accepted artifacts, or
ship the planned product behavior.

## 2. Reconciled Baseline And Acceptance Map (#1013)

Inspected on 2026-10-19 against the owned checkout of `main` at
[`f734ef8bf1d27e3219b2122aed089421f61b7ca8`](https://github.com/ebarti/JobCtrl/tree/f734ef8bf1d27e3219b2122aed089421f61b7ca8).
All current code paths and test names below refer to that pin. Historical PR
records establish design lineage; their checks do not validate this candidate.
No real profile, workspace, database or provider account was inspected.

### 2.1 Reused, superseded, and missing

The retained local merge commits and the earlier integrated design establish:

| Foundation and pinned evidence | Reuse | Superseded or still missing |
| --- | --- | --- |
| [#955, `0aa939cde`](https://github.com/ebarti/JobCtrl/commit/0aa939cde09b46af331178fb660ebc9a2ac90ee8), this plan's original sections 3–4 | Noncanonical draft, exact human acceptance, provenance, versioned promotion and stable evidence identity remain the design owner. | Its baseline was `6a82c233`; “no browser profile version / no expected-version check” is obsolete. Its comparative evaluation/cohort prescription is superseded by the semantic-determination decision. No draft repository, multi-source reconciliation or promotion endpoint shipped with this design. |
| [#956, `06017c591`](https://github.com/ebarti/JobCtrl/commit/06017c59136be2ea95a33adc3d33577f89ebf7f2), `apps/api/src/profile-store.ts`, `packages/contracts/src/schemas.ts` | `profileVersion` reads, optional `expectedProfileVersion` writes, typed stale conflicts and snapshot-bound role references are existing foundations. | Its partial deterministic role-suggestion fallback is historical; #1064 replaces semantic heuristics. A version-fenced profile save is not a draft promotion ledger. |
| [#978, `97b4fd5c3`](https://github.com/ebarti/JobCtrl/commit/97b4fd5c34a4851150e4252002b04b5191801602), `apps/web/src/contexts/profile/forms/profile-form.tsx` | Initially unselected proposals, explicit selection, editing/rejection, ordinary version-fenced save, draft preservation and rebase behavior provide a review precedent. | This reviews target search proposals from saved facts, not conflicting imported evidence. Historical location/work-model evidence is not present-day consent. |
| [#1064, `0b61aef78`](https://github.com/ebarti/JobCtrl/commit/0b61aef78b03d6d198e34c561c69ae0eec921969), `domain/profile/resume_extraction.py`, `domain/determinations.py` under `workers/automation/src/jobctrl/` | Strict field-span extraction, pending interpretations, persisted determination envelopes, source/version binding, profile lane and spend preflight; readers join recorded IDs. | Replaces lexical meaning checks and inferred strength/seniority facts. Extraction still returns a whole-profile draft with import-local ordinal entry IDs; it does not reconcile canonical identities or retain item-level review decisions. |
| [#830, `4644f0a8e`](https://github.com/ebarti/JobCtrl/commit/4644f0a8e0c3d6bd9de474dfdeebea6a4e520936) | Achievement ownership and exact numeric source binding remain constraints; no metric borrowing between roles/achievements. | Historical lexical fabrication gates are superseded by #1064's claim determinations. No authority to promote generated text follows from artifact validation. |
| [#868, `85415c7f6`](https://github.com/ebarti/JobCtrl/commit/85415c7f641e090bf330f0e7ae9333694055391a) and [#869, `7fd68570d`](https://github.com/ebarti/JobCtrl/commit/7fd68570da18d82677864fb045bb743b1660bf16) | One Materials batch/candidate lifecycle, retained evaluated candidate evidence, cancellation/ownership fences and preservation of accepted artifacts. The [retained delivery record](implemented/2026-09-06-simplification-stack.md#completion-record) records historical checks and corrections. | Those historical results are not fresh intake proof. New intake adds no Materials retry or artifact writer; selective composition and residual Tailor dispositions remain separate future work. |

Current import still marks all imported experience, education and skill
categories required (`profile_import.py:profile_from_extraction`). Empty
required **entry/category** lists still fall back to all entries
(`domain/profile/aggregate.py:required_experience_ids`, `required_education_ids`,
`required_skill_category_ids`). This does not imply every bullet is a hard pin.
The proposed `legacy_all`/`selective_v1` policy fields do not exist today.

### 2.2 Current entry → handoff → save → recovery

| Boundary / current owner at the pin above | Inspected behavior | Executed proof and limit |
| --- | --- | --- |
| Browser `/profile/import/upload`, preview, confirm; `import-upload-form.tsx`, `import-confirm-form.tsx`, `stores/profile-import-store.ts` under `apps/web/src/contexts/profile/` | Upload stores filename/base64 and profile/style options in browser-local persisted state. Preview/confirm review the source and scope, not extracted fact decisions. | Source inspection only; no rendered browser measurement here. |
| HTTP `POST /v1/profile/import-resume`; `apps/api/src/server.ts`, `local-actions.ts:createProfileImporter` | Validate request/base64, write an owned upload under `profile-imports`, call registered `profile_import` RPC with expected runtime paths and `awaitResult: true`, return draft plus action metadata. | Server tests `imports resume PDFs through an injected profile importer without running Python in tests` and `rejects malformed resume import payloads before importer dispatch` measure HTTP only, with an injected importer. |
| RPC → Temporal; `infrastructure/rpc/handlers.py:profile_import`, `workflow_specs.py:build_profile_import_workflow_spec`, `profile/workflow.py`, `profile/activities.py` under `workers/automation/src/jobctrl/` | Registered starter builds `ProfileImportWorkflow`; workflow checks profile spend then invokes the heartbeat activity with runtime guards, records lifecycle outcomes and returns the draft. | `test_activity_profile_import.py::test_profile_import_activity_returns_draft_from_importer` executes a local Temporal harness and the actual activity with a patched importer. It does not execute the production starter/workflow/extraction chain. |
| Extraction → draft; `profile/importer.py`, `domain/profile/use_cases.py:ImportProfileUseCase`, `infrastructure/profile/{factory,sqlite_repository,pdf_parser}.py`, `domain/profile/resume_extraction.py`, `profile_import.py` | Load saved base/style; parse PDF; use strict model extraction with verbatim field spans and exact numeric validation. Persist the determination; return `pending_confirmation` source metadata including `determinationId`. `ProfileImported` is an import notification, not promotion. Missing personal fields retain base values; missing optional resume fields become empty strings and absent resume sections become empty lists in the draft. Extracted resume lists replace draft lists. Existing canonical rows are untouched. | `test_profile_import.py` measures a synthetic PDF and style inference. `test_profile_determinations.py::test_resume_extraction_stays_a_draft_and_requires_exact_numbers` uses a model double and owned SQLite. Repository/use-case tests establish normalized persistence boundaries. |
| Returned draft → browser editor; `hooks/useImportResumeMutation.ts`, `forms/import-confirm-form.tsx`, `components/ProfileEditor.tsx`, `readQueries.ts`, `forms/profile-form.tsx` | **Missing handoff:** confirmation uses only `response.action?.status`, resets the upload store and navigates to `/profile`. The mutation invalidates saved-profile reads. No returned `profile`/`style` is staged into the editor; the editor receives saved data. There is no multi-source review store. | Source inspection, not a browser execution. HTTP import success cannot establish editor hydration or a saved import. #1013 specifies the needed handoff; this docs-only delivery preserves behavior. |
| Editor → `PATCH /v1/profile`; `profile-form.tsx`, `apps/api/src/{server,profile-store,profile-events}.ts` | Form saves use the supplying `profileVersion` for existing profiles. HTTP supports an optional expected version for compatibility; proposals require their version authority. `persistProfileUpdate` wraps normalization, rows/version and changed-section `ProfileUpdated` in one transaction. Unchanged saves do not advance the profile or emit another change event. | Candidate confirmation tests plus selected server stale-suggestion, rollback, unchanged and concurrent-save cases measure actual API/SQLite boundaries; they do not implement imported-fact acceptance. |
| Commit → continuation → restart; `profile-events.ts`, startup/dispatch in `server.ts` | After commit, durable intent/dispatch/acknowledgement recovers from pending `ProfileUpdated` events. Identical saves coalesce; pending newer revisions coalesce while already-intended older work reattaches first. Follow-up failure cannot undo the save. | Server tests `recovers an unacknowledged profile continuation on API startup`, `does not launch startup continuations before the health-only database exists`, and `reattaches an intended older profile continuation before dispatching a newer revision`; dispatcher doubles, not live scoring/tailoring. |
| Canonical snapshot → downstream consumers; `domain/profile/snapshot.py` | Immutable deep-copy snapshots bind work to a profile version; imported drafts are not inputs to scoring, Materials, Discovery, Evidence Map or Apply. Historical snapshots and accepted artifacts must survive later changes/failures. | `test_profile_snapshot.py` tests deep-copy and metadata behavior. End-to-end downstream refresh and accepted-file preservation were not exercised by these focused checks. |

### 2.3 Remaining acceptance and delivery boundary

Section 4 defines the missing Profile-owned draft/source/review/promotion
contract. Section 8 maps each current measurement and prospective scenario to
its owner. Multi-source collection, repeat-source revision handling, canonical
identity reconciliation, item review, durable acceptance/provenance and
idempotent promotion remain **unimplemented**, including browser draft handoff.
No framework, migration, production endpoint or selective-tailoring change is
authorized by this investigation.

The #1013 delivery path is this documentation checkpoint → controller-owned
single early unmerged PR → independent review and QA plus concurrent CI where
permitted → batch repair/recheck → controller settlement at the unmerged PR.
Publication requires retained passing evidence for the candidate's mandatory
`checks.diff`, `checks.docs`, independent review/QA and applicable required PR
CI, including Docs Site / Build's dead-link gate and rendered docs runtime
check. Changed documents invalidate affected evidence; unchanged source-bound
measurements may be reused with explicit limits. Actual start/finish times
belong in retained runtime records. This design records no future gate outcome
and authorizes no merge, release, deployment, statistics reset or other intake.

## 3. Invariants

The implementation is acceptable only if all of these remain true.

### 3.1 Evidence ownership

- Draft capture is noncanonical. A draft may contain a question, source
  excerpt, tentative claim, contradiction, or missing field without making it
  available to scoring, Materials, Apply, Discovery, or the Evidence Map.
- Canonical promotion is explicit, item-scoped, and version checked. The user
  selects the facts to promote and accepts the exact normalized values.
- Each promoted fact records stable source provenance and user acceptance.
  Evidence IDs are durable across downstream planning and audit.
- The job is selection context, never evidence about the candidate.
- A model may propose wording or questions, but it may not invent a metric,
  outcome, title, scope, skill, preference, or career intent.

### 3.2 Compatibility

- Under the proposed policy, existing profiles remain `legacy_all`. Existing
  empty required-entry/category lists continue to mean all entries; explicit
  pins retain their current meaning. Empty bullet pins do not force all bullets.
- Existing imported evidence remains available and existing import defaults do
  not change until the user explicitly converts the profile to the new policy.
- `selective_v1` is an opt-in, versioned policy. It is never inferred from an
  empty list or introduced by a database backfill.
- Existing accepted artifacts remain current until a replacement is approved.
  Conversion, failed generation, rejection, cancellation, or audit failure
  cannot hide or delete the last accepted artifact.
- Existing immutable Discovery execution plans, Apply approvals, scores, and
  material generations retain the profile and policy versions they used.

### 3.3 Deterministic audit

- Every selected claim resolves to canonical evidence IDs from the exact
  profile version used by the generation.
- Every eligible but omitted item receives a bounded reason such as budget,
  duplication, lower requirement relevance, lens mismatch, chronology
  compression, unresolved contradiction, or insufficient evidence.
- Selection and omission records survive prompt execution and are reconciled
  against the final assembled text, rendered HTML, and rendered PDF.
- Word, page, role, bullet, and skill measurements come from the actual
  candidate artifact at the appropriate stage. The read model does not
  reconstruct missing generation-time decisions.
- User edits invalidate affected grounding, coverage, metrics, and skim results
  until those checks run again against the edited artifact.

### 3.4 Backward-compatible evidence-reference identity

Evidence references are typed identities, not array positions or text hashes.
Existing experience, education, skill-category, and authored achievement IDs
remain canonical. Selective conversion adds durable leaf IDs to the normalized
bullet and skill-item rows and exposes additive sidecar IDs beside the existing
string arrays, so legacy readers and empty-pin behavior remain unchanged.

Each legacy leaf receives its ID once during an atomic conversion/import
migration. The stored ID survives reorder and wording edits, and duplicate text
gets distinct IDs. Before conversion, a transient consumer such as #902 may use
a typed reference scoped to the exact `profileVersion`, parent entry/category
ID, and occurrence ordinal. Such a reference is valid only against that
snapshot; it cannot be promoted, carried across a profile version, or persisted
as a durable artifact-audit reference. Every acceptance and audit boundary
resolves incoming references against the exact snapshot and rejects unknown,
duplicated, stale, or wrong-kind IDs.

## 4. Draft Evidence Capture And Promotion

### 4.1 Draft and source records (proposed, not implemented)

Extend the existing `EvidenceCaptureDraft` design inside Profile; do not create
a parallel candidate authority. Initial sources are user-supplied local PDFs,
excerpts or authored answers. Automatic web research, external account intake,
resume generation and eligibility judgments are outside #1013.

| Record | Required identity, revision and authority |
| --- | --- |
| Draft | Stable draft ID, tenant/profile owner, monotonic draft revision, base profile version, capture status and immutable proposal/review history. Browser handoff stages this draft by ID/revision and keeps unsaved editor changes separate until deliberate review. Reload resumes the same draft; navigation is not acceptance. |
| Source | Stable local source ID independent of filename/path, immutable source revision, exact-byte content digest, media kind, capture time and user-supplied label; extraction text revision/digest and extraction determination ID. Keep the original bytes/text locally inspectable. A byte hash identifies content, not ownership or truth. |
| Ownership | Candidate / named third party / generated / ambiguous, with the owner's explicit clarification and supporting source references. A team or employer statement cannot become an individual's achievement. Generated text may be retained as a proposal or question, never sole factual support. |
| Provenance | Source ID **and revision**, page/field/span locator, verbatim excerpt, extracted value, determination envelope ID, schema/prompt/provider/model versions and input fingerprint. A normalized proposal links to these immutable records; it never replaces the quoted source. |
| Proposal | Stable draft-item ID and item revision, exact proposed normalized value or explicit unknown, supporting/contradicting references, proposed operation (`add`, `link`, `replace`), canonical target kind/ID and observed profile version, or a provisional new-item identity. Array position, filename, wording and text hashes are not canonical targets. |
| Review | Per-item `unreviewed`, `needs_evidence`, `contradicted`, `deferred`, `rejected`, or committed `accepted`; exact reviewed value, target, source revisions and human decision. Selection alone is not committed acceptance. Retain rejection/deferral and questions across sessions. |

Drafts, source excerpts, determinations and answers are private local profile
data. They never enter public issues, fixtures, general telemetry or prompt
logs. Future retention follows the owning safety policy; no cleanup deletes a
source required to explain a committed acceptance or historical snapshot.

### 4.1.1 Reconciliation rules

- Reimporting the same bytes for the same owner reuses the source revision;
  an alternate filename is another observation, not a new canonical fact.
  Changed bytes explicitly attached by the owner to the same source are a new
  immutable revision; a shared filename alone cannot establish that association.
  Existing reviews remain bound to the old revision until explicitly reconsidered.
  Identical text in different sources retains both provenance records.
- Exact source identity checks are mechanical. Non-exact duplicate meaning,
  ownership, contradictions and proposed target matches use source-bound model
  determinations. Similar titles, token overlap, prose thresholds or nearest
  array positions cannot merge facts. The UI presents a **proposed duplicate
  link**; the user confirms link/add/replace independently for each item.
- Linking another source to an existing fact preserves its canonical ID.
  Reordering items or changing wording never changes that identity. New facts
  receive stable canonical IDs at promotion, with an explicit provisional-to-
  canonical mapping retained in the receipt. Existing parent and authored
  achievement IDs survive; durable leaf references follow section 3.4.
- Competing dates, employers, titles, scope, metrics or outcomes remain visible
  side by side with the saved value and both sources. No last-source-wins,
  source-majority or higher-confidence overwrite. Replacement requires the
  exact old target, new normalized value and human resolution; unresolved
  conflicts stay noncanonical while unrelated facts may proceed.
- Missing source fields mean “not supplied”; explicit unknown means “not known”.
  Neither clears a known canonical field, infers zero/false, creates a metric,
  invents a date or fills an attestation. Withdrawing a known fact is a separate
  explicit reviewed operation. Schema-required unknowns remain draft questions.
- Ambiguous candidate/team/third-party ownership blocks promotion of that item.
  The user may clarify with an authored source, reject, or defer. Confidence is
  descriptive and grants no authority. Imported skills/prose cannot establish
  career intent, work authorization, screening attestations or search consent.
- Partial review commits only the selected, resolved items. Rejected and
  deferred items remain in the draft, excluded from snapshots and downstream
  readers. Editing a value, target or supporting revision invalidates its old
  review. The review UI must show the normalized value actually being accepted.

### 4.2 Evidence sufficiency

A fact is promotable only when the owning schema accepts it and its evidence
record answers the dimensions applicable to that fact:

| Dimension | Required proof |
| --- | --- |
| Identity | The target profile field or achievement has a stable ID. |
| Ownership | The statement is about the candidate and is user-owned or from an explicitly identified source. |
| Provenance | At least one inspectable source reference exists; derived wording links to the source rather than replacing it. |
| Claim content | Achievement claims distinguish scope, action, tools, metric, and outcome; unavailable parts stay unknown. |
| Confidence | Confidence reflects source quality and contradiction state; it is not a substitute for acceptance. |
| User decision | The user accepts the normalized value and its target location. |
| Consistency | Known contradictions are resolved or the fact remains in the draft. |

Narrative polish alone is never sufficient. A plausible metric without a
source, a responsibility presented as an outcome, or a generated claim with no
canonical target remains nonpromotable.

### 4.3 Question strategy

Questions are generated from missing claim dimensions and contradictions, not
from a generic interview script. A source-bound model proposes the smallest
useful question; code validates its source/target references and executes the
explicit review order:

1. identify the role, project, or skill the answer belongs to;
2. recover the user's action and ownership;
3. ask for outcome, scale, frequency, duration, or comparison only when the
   current evidence lacks it;
4. ask the user to resolve competing dates, titles, metrics, or ownership; and
5. allow “unknown”, rejection, or deferral without blocking unrelated facts.

Executive prompts seek evidence of organizational scope, strategy, operating
cadence, business outcome, and cross-functional ownership. Staff/Principal
prompts seek technical depth, architecture, difficult tradeoffs, system impact,
technical influence, and durable engineering outcomes. Both use the same
evidence rules; neither lens upgrades unsupported seniority.

### 4.4 Promotion transaction and recovery (prospective)

Reuse the normal Profile use case/transaction owner, adding a narrow draft
promotion command only after implementation authorization. It carries the draft
ID/revision, selected item IDs/revisions, exact accepted normalized values,
source revision references, canonical target IDs/observed values,
`expectedProfileVersion`, and a client-stable operation ID with a request digest.
Normalizers and schema validation run before the review is bound: if the server
would change a reviewed value, return it for another explicit review. A model
response or editor autosave cannot supply human acceptance.

In one transaction, the owner must:

1. Check an existing operation receipt first. An exact retry returns its prior
   result and ID mapping even if the current profile has since advanced. Reuse
   of that operation ID with a different request digest is a typed conflict.
2. Compare the current draft revision and profile version, item revisions,
   source revisions, ownership/resolution state, and every target kind/ID/value.
   Reject foreign, removed, duplicate, wrong-kind or snapshot-only stale
   references. No partial mutation or silent rebase is permitted on a mismatch.
3. Apply only accepted items, preserving existing canonical IDs and allocating
   new IDs once. Atomically persist facts, provenance, human acceptance records,
   the operation receipt/ID mapping and the resulting draft revision. Advance
   the profile version and record the normal `ProfileUpdated` event only for a
   canonical content change. Accepting additional provenance for an unchanged
   value records review/links/receipt without manufacturing another content
   version or preparation event.
4. Commit all of the above or none. A failed event/receipt/provenance write
   leaves profile, draft acceptance and accepted history unchanged. Stale or
   invalid commands produce no new continuation work.

After commit, the existing recoverable continuation path records dispatch
intent, dispatches preparation and acknowledges or retries it. It stays outside
the fact transaction. The committed event is the recovery anchor if the process
stops before intent creation; no model or dispatch call occurs inside the
promotion transaction. Post-commit failures must be reported as a saved change
with follow-up status, never as a reason to repeat the fact write.

On a lost response, read the operation receipt and reload draft/profile state;
never guess acceptance from similar text or blindly resubmit as a new operation.
Rebase is an explicit draft revision with a fresh review of overlapping values,
removed targets, changed sources and new contradictions. Unaffected proposals
may remain; their old snapshot references cannot authorize a write to a new
profile version. A receipt preserves the exact accepted revision and IDs even
when later saves supersede them.

Cancellation fences proposal installation and acceptance at the owning revision.
Before commit it leaves canonical rows untouched; after commit it cannot undo
accepted facts or erase the receipt. Restart reuses persisted determinations and
review state; it does not replay provider output as a fixture or ask a provider
to reconstruct prior decisions. Historical downstream snapshots stay bound to
the profile they used. Failed extraction, reconciliation, refresh, dispatch or
replacement never deletes the last accepted profile facts or material artifact.

### 4.5 Semantic authority and preflight

Follow the accepted [semantic-determination decision](../decisions.md#_2026-10-07-semantic-judgments-are-llm-determinations)
and [auditability checks](../developer/qa/regression-catalog.md#auditability-checks).
New extraction/reconciliation/question judgments use strict source-bound
`LlmPort.chat_json` determinations with minimized local inputs, closed schemas,
canonical source IDs and verbatim citations. Persist kind, schema/prompt
versions, provider/model, input fingerprint and validated result before readers
can show a proposal. Readers join recorded IDs; they do not reconstruct a
rationale through similarity. Prompts treat uploaded text as data, not commands.

Profile-lane and existing spend preflight precede every new call. Identical
inputs and versions may reuse a valid stored determination without another
call; changed source/draft/profile versions require rebinding and review.
Mechanical validation checks ID membership, quote binding, complete numeric/date
values, structure and versions. Meaning belongs to the model; neither regexes,
word lists nor confidence thresholds may decide duplicates, support or ownership.
Provider unavailable/error, spend denial, malformed output, schema violation,
foreign references, non-verbatim citations and mismatched values have distinct
blocked outcomes with no lexical fallback or implicit fact promotion. Refresh
failure retains prior accepted records and the user's current draft. This design
changes no provider, model, lane or budget policy.

## 5. Selective Resume Contract

### 5.1 Policy modes

`ResumeSelectionPolicy` is versioned and stored with the profile:

- `legacy_all`: preserve current required-list fallback and import behavior;
- `selective_v1`: distinguish hard pins from the eligible evidence inventory
  and require a per-job narrative plan before composition.

Conversion is explicit and previewable. It shows how current required lists
map to hard pins and does not generate or replace an artifact. A failed or
cancelled conversion changes nothing.

### 5.2 Evidence inventory before the Resume Brief

The worker builds one immutable `ResumeEvidenceInventory` from the canonical
`ProfileSnapshot`. It contains eligible roles, education, skills, achievements,
evidence strength, chronology, hard pins, provenance IDs, and contradictions.
It is exhaustive; it is not a resume and has no job-specific omission.

Only then does Materials build a job-specific `ResumeBrief` from:

- the exact inventory and profile version;
- the canonical employer requirements and requirement-fit evidence;
- the selected narrative lens;
- explicit user pins and exclusions;
- the selected `ResumeArtifactBudget`; and
- the applicable tailoring and generation policy versions.

The brief states target scope, headline/trajectory, requirement priorities,
required evidence coverage, chronology strategy, and the evidence candidates
for composition. It cannot add facts absent from the inventory.

### 5.3 Distinct narrative lenses

The lens changes selection priorities and presentation, not evidence truth.

| Lens | Selection emphasis | Prohibited shortcut |
| --- | --- | --- |
| Executive | Organizational scope, strategy, business outcomes, leadership systems, operating leverage, and cross-functional accountability | Treating team size, title, or generic management language as proof of executive impact |
| Staff/Principal | Technical depth, architecture, system outcomes, difficult tradeoffs, technical leadership, and influence across teams | Treating management responsibility or tool lists as proof of Staff/Principal impact |

Mixed-history candidates may preview either lens. The chosen lens and any
intentional secondary signal are stored in the brief; the system does not
silently blend both into one universal template.

### 5.4 Configurable artifact budgets

`ResumeArtifactBudget` can constrain:

- total roles and recent-versus-older role detail;
- total bullets and per-role bullet ceilings;
- total selected `AchievementEvidence` items and per-role achievement-evidence
  ceilings, independently of bullet ceilings;
- total words and words by section;
- rendered pages for the selected template and paper size; and
- total skills and per-category skill ceilings.

Hard pins and required requirement coverage are constraints, not hidden
exceptions. When they cannot fit, planning returns typed
`artifact_budget_infeasible` evidence listing the conflicting pins, coverage,
selected-achievement requirements, and exact global/per-role budget dimensions.
The audit records both planned and actual selected-achievement counts by role;
assembling several achievements into one bullet does not evade the evidence
budget. It never silently drops forced content or claims a valid artifact that
exceeds an enforced budget.

Defaults remain undecided. Any future choice requires owned structural
measurements and explicit policy approval under section 8, without evaluation
corpora or baseline comparisons. Defaults may vary by lens, template, paper
size, and profile shape. User-configured values and explicit pins remain
inspectable inputs.

### 5.5 Selection, compression, and chronology

`ResumeNarrativePlan` contains a `RoleDecision` and evidence decisions for every
eligible item:

- `selected_full`, `selected_compressed`, or `omitted`;
- canonical evidence IDs and requirement links;
- deterministic reason codes and bounded explanation;
- proposed section, ordering, and bullet allocation; and
- hard-pin and budget effects.

Recent roles receive no automatic truth privilege. Recency is one ranking
signal; older unique evidence remains eligible when it best proves a priority
requirement or trajectory. Compression preserves employer, title, and truthful
chronology. It may reduce detail but cannot merge roles, move achievements, or
rewrite dates to improve appearance.

## 6. Generation, Rendering, And Audit

The plan extends the existing canonical batch and evaluated-candidate flow:

1. create the inventory and Resume Brief once for the execution;
2. validate source-bound model selection decisions against IDs, pins and budgets;
3. give the generator only the selected evidence and explicit brief;
4. run existing grounding, achievement fidelity, requirement coverage,
   fabrication, judge, adversarial, and voice gates;
5. reassemble structured text from the candidate and selection decisions;
6. render HTML and PDF with the selected template;
7. measure actual text, section, line-wrap, and page outcomes;
8. run skim-quality checks against the actual artifact; and
9. persist one source-of-truth audit before the candidate can be accepted.

`ResumeArtifactAudit` records the inventory, brief, policy and budget versions,
selected and omitted evidence, hard-pin resolution, requirement coverage,
actual text/HTML/PDF metrics, validator and judge outcomes, skim assessment,
repairs, and acceptance decision. Legacy generations expose an honest
`legacy_missing` state for fields that were never recorded.

The artifact detail UI must show generation-time decisions and the final
artifact comparison without deriving a more favorable explanation later.

## 7. Execution Ownership And Failure Handling

- The existing Materials canonical batch owns the attempt series, selected
  candidate, cancellation fence, and spend ceiling. This program adds no
  competing retry loop or Temporal workflow.
- Generator, judge, adversarial, voice, and rendering repairs consume explicit
  bounded attempt and spend budgets. A deterministic assembly or budget failure
  cannot be retried through a model prompt.
- Cancellation prevents late candidates, renders, or audits from becoming
  current. Stale owners cannot accept or replace an artifact.
- A failed, rejected, cancelled, or over-budget refresh records its result and
  leaves the last accepted artifact visible and usable.
- The API and UI report whether a warning affected repair, remained on the
  selected candidate, or appeared after acceptance.

## 8. Current Measurements And Prospective Validation

### 8.1 Observed current contracts

On the section 2 source pin, owned synthetic checks produced the following
results on 2026-10-19. Production source/tests and lockfiles were unchanged.
These are investigation measurements, not proof of multi-source intake or the
edited documentation candidate's required publication gates.

| Measurement | UTC start → finish | Actual outcome and scope |
| --- | --- | --- |
| Locked worker pytest, seven files listed below | 15:26:57.509075 → 15:27:13.782428 | 58 passed, zero skipped/errors/failures; synthetic PDF, normalized SQLite, snapshot copying, local Temporal activity harness with importer double, and fake-model authority/binding/failure checks. No live provider. |
| API `candidate-confirmation.test.ts`, `profile-events-v7.test.ts` | 15:26:57.509377 → 15:27:00.962409 | 4 passed, zero skipped/errors/failures; unchanged confirmation, stale confirmation preservation, version-scoped status, canonical event/approved-resume lookup. |
| API selected `server.test.ts` cases from section 2 and below | 15:27:00.964445 → 15:27:11.667966 | 10 passed, zero selected cases skipped/failed. JUnit includes 314 unrelated cases excluded by the explicit name selector; this is not a full server-suite pass. Injected import/dispatch adapters, actual HTTP/SQLite. |

The worker command uses the controller-prepared Python 3.12.13 environment:
`uv --project workers/automation run --locked --all-extras --python <prepared-python> pytest`
with the explicit paths under `workers/automation/tests/`:
`test_profile_import.py`, `test_activity_profile_import.py`,
`test_profile_use_cases.py`, `test_profile_determinations.py`,
`test_sqlite_profile_repository.py`, `test_profile_snapshot.py`,
`test_semantic_determinations.py`, plus `-q --junitxml=<owned-report-path>`.
API commands use the recorded Node 22.21.1/Corepack environment and
`corepack pnpm --filter @jobctrl/api exec vitest run`, explicit test paths,
`--reporter=junit --outputFile=<owned-report-path>`. The server command selects
these exact inspected names with `-t` (joined by `|`):

- `imports resume PDFs through an injected profile importer without running Python in tests`
- `rejects malformed resume import payloads before importer dispatch`
- `atomically rejects stale suggestion saves without a profile event`
- `does not redispatch preparation when a form resubmits the unchanged profile`
- `rolls back the profile mutation when its durable continuation event cannot commit`
- `coalesces concurrent identical profile saves into one version and continuation`
- `coalesces simultaneous genuine profile revisions into the newest durable continuation`
- `recovers an unacknowledged profile continuation on API startup`
- `does not launch startup continuations before the health-only database exists`
- `reattaches an intended older profile continuation before dispatching a newer revision`

The controller-allocated retained implementation evidence contains `probe.py`,
exact argv/environment, stdout/stderr, UTC records, source/lock hashes,
`source-bindings.json`, the documentation diff and JUnit reports. Report hashes
bind these observations independently of a host path:

| Retained report | SHA-256 |
| --- | --- |
| `worker-contracts.xml` | `2d8c55d11b834018568140be2ea8a3e53ce15b6509289d6230bbbef5ca8f96ce` |
| `api-confirmation-events.xml` | `36290aa62597696a22a656a62ba15feb5c917c57e377b0936003aa063bbf90a9` |
| `api-entry-recovery.xml` | `3db67f62c9c1a11e16e45c0dfb3cbab549eb2d30b21927c749b170faa3e2f8e2` |

The copied preparation receipt (SHA-256
`04501b02093824aba634bf92bdd1d552200aebe6e5405183a0f8b40fbee3f1a0`)
contains baseline dependency/native preparation and a baseline diff check,
not prior browser or feature proof. There are no prior-iteration feature
measurements in that handoff. Historical #955/#956/#978/#1064 commit records and
#868/#869 retained delivery evidence were inspected locally; remote PR checks
were not refreshed. No claim of semantic accuracy follows from model doubles.

### 8.2 Required scenario map for a future implementation

Every row below is a requirement, not an implemented outcome. Reuse existing
proof only for the unchanged boundary it actually exercises. Run owned invented
inputs through the real entry points and persistence before first product use;
record complete outputs and failure status. Do not create evaluation sets,
labeled corpora, comparative baselines or recorded-output replay fixtures.

| Scenario / owning boundary | Current measured coverage | Prospective acceptance proof |
| --- | --- | --- |
| Multiple local sources → review/editor | None; current browser handoff is missing by inspection. | PDF plus authored answer/excerpt reach the same durable draft with separate source revisions. Reload and unsaved editor changes survive; neither import nor navigation saves facts. |
| Repeat source / revised source / duplicate wording / reorder | Ordinal `import:*` draft IDs inspected; no reconciliation coverage. | Same bytes/renamed file reuse the revision; changed bytes create a revision. Duplicate text in separate roles stays separate. Proposed duplicate links require human choice; confirmed links and canonical IDs survive reorder and wording edits. |
| Conflicting title/date/metric / ambiguous team ownership | Model authority tests only, no reconciler. | Show both sources and saved value; contradict/defer one item while accepting unrelated items. No majority, confidence or lexical rule overwrites a fact; ownership clarification retains its authored source. |
| Missing values / unknown / absent section | Strict extraction null/list schema and no fabricated achievement; no reviewed merge. | Unknown stays unknown and absent input preserves known values. No defaults create dates, metrics, targets or attestations; required unknowns stay questions. |
| Partial accept / reject / defer / edited proposal | Existing candidate confirmation is version-bound, not imported-item review. | Only exact reviewed normalized values/targets promote; other items remain draft. Changed value/source/target invalidates acceptance. Reopen review with each prior decision intact. |
| Stale profile, draft or source revision | Selected API stale suggestion test; confirmation stale test. | Reject each independent stale boundary atomically; retain local draft and existing facts. Explicit rebase rechecks overlaps/removals and cannot reuse stale snapshot references. |
| Foreign, duplicate, removed or wrong-kind target / citation | Shared semantic failure and source-binding tests; no promotion target validator. | Every target resolves in the exact snapshot and every quote/value in the exact source revision. Reject all invalid variants before writing facts/review/event. |
| Provider unavailable/error / spend denied | `test_profile_determinations.py` and `test_semantic_determinations.py`: explicit doubles, lane/preflight/cache checks, distinct safe failures. | Repeat through the import/reconciliation RPC/activity and browser blocked state. No new provider call after denied preflight, no lexical fallback, existing accepted records and unsaved work retained. |
| Malformed JSON / extra field / unknown enum / non-verbatim / mismatched numeric value | Shared determination tests cover each; resume extraction checks exact field spans/numbers. | Exercise the same failures in multi-source proposals. Persist blocked status separately from prior accepted results; readers use recorded IDs. Opposite valid model decisions on identical sources must control semantic results. |
| Acceptance write/event/provenance/receipt failure | API profile-event rollback measured; multi-source transaction absent. | Inject failure at every added write; no partial fact, acceptance, source link, event or dispatch. Success commits the full receipt and canonical ID mapping together. |
| Retry / double click / lost response / post-commit new edit | Unchanged/concurrent current saves coalesce; no promotion receipt. | Exact operation retry returns the first receipt without new IDs/event/version; changed payload with same key conflicts. Read receipt after lost response, including after later profile changes. |
| Cancellation / late result / restart | Production import workflow cancellation inspected, not executed here. | Cancel before/after model return and before commit; stale owners cannot install a proposal or accept. After commit, receipt remains authoritative. Restart resumes draft/decisions and cached envelopes without reconstructing meaning. |
| Commit → intent → dispatch → acknowledgement recovery | Three selected startup/reattachment cases measured with dispatcher doubles. | Stop at each boundary using the real integration; recover the committed event without repeating fact acceptance or creating a competing continuation series. |
| Snapshot / downstream refresh failure | Deep-copy/version tests; no downstream lifecycle execution. | Historical scores/search plans/approvals/materials retain their versions. Failed or cancelled refresh leaves prior accepted artifacts readable and approved history intact. No imported draft leaks to consumers. |
| Browser/API/RPC/workflow complete path | Individual boundaries only; no full product run. | Owned synthetic browser → actual HTTP → registered RPC → Temporal → strict model adapter → draft review → promotion → restart → snapshot reads. Model doubles prove authority/failures; a separately authorized configured-provider call establishes live integration, never implied by doubles. |

The broader selective-composition proposal still needs structural checks for
pins, independent achievement/bullet budgets, infeasible constraints, chronology,
actual text/HTML/PDF dimensions and invalidation after user edits. Semantic
relevance, support, ownership and lens choices remain typed model decisions;
code validates recorded IDs, exact values, arithmetic and artifact structure.
No numeric defaults or model/budget changes are selected by #1013.

## 9. Dependent Delivery Slices

These are historical program-level implementation proposals, not work items
authorized by #1013. This issue remains one docs-only delivery and one unmerged
PR, with no sub-issues or implementation stack. Any later implementation needs
separate authorization and must not ship around an unaccepted contract.

### Slice 1 — Contract and validation groundwork

- Add versioned draft, promotion, selection-policy, brief, budget, decision,
  metrics, skim, and audit schemas.
- Add owned synthetic model-authority, structural and failure/binding checks;
  no evaluation corpus or recorded-output replay fixtures.
- Reuse the shipped browser/API profile-version reads and conditional writes;
  add only the missing durable draft/evidence reference contract.
- Exit: legacy reads remain valid; unknown evidence and stale version tests fail
  closed; proposed defaults remain absent.

### Slice 2 — Draft capture and canonical promotion

- Add Profile-owned draft repository/use cases, question planner, provenance
  and contradiction UI, and atomic expected-version promotion.
- Exit: accepted items alone enter canonical rows and emit the normal profile
  event; rejection, conflicts, and stale saves cause no canonical mutation,
  profile event, continuation intent, or dispatch work.

### Slice 3 — Tailor inventory and accepted disposition

- Inventory every surviving Tailor entry point, retry/repair loop, artifact
  suppression path, and owner after #868/#869. At minimum this includes the
  `suppressExistingArtifacts` branch in the main Materials use case, the
  separate `SuppressTailoredArtifactsUseCase`, HTTP/RPC/Temporal/CLI callers,
  and the voice-adapter contract.
- Record a `retain`, `merge into canonical batch`, or `remove` disposition for
  every inventory row, with callers, cancellation owner, attempt/spend owner,
  suppression semantics, and last-accepted-artifact effect. No surviving path
  may start an independent retry series or suppress an accepted artifact before
  a replacement is accepted.
- Bring voice generation under the canonical attempt/token/spend budget and
  acceptance fence. Reinspect the voice-adapter contract at implementation time
  and close any remaining unbounded path so a late result cannot exceed the
  selected candidate budget or replace the last accepted artifact.
- Exit: repository-wide call-site evidence proves that each entry point and
  loop has one named owner and recorded disposition; deleted paths have no live
  callers; retained paths share the canonical batch, cancellation fence,
  budget, audit, and accepted-artifact rules. The disposition table and its
  ownership/suppression/retry/voice decisions require review acceptance before
  any `selective_v1`, assembly, rendering, or Tailor-path implementation begins.

### Slice 4 — Selectivity, cleanup, rendering, and artifact audit

- Implement the accepted Slice 3 dispositions: remove or merge redundant entry
  points and loops before adding behavior to retained owners.
- Add explicit `selective_v1` conversion, inventory, Resume Brief, narrative
  planning, budget enforcement, source-bound selection and deterministic assembly, actual
  render metrics, skim checks, and persisted audit only through those retained
  owners.
- Reuse #830 achievement fidelity and #868/#869 batch/candidate ownership.
- Exit: the accepted disposition is reflected in live call sites; text, HTML,
  and PDF reconcile to the same selected evidence; and the last accepted
  artifact survives every failed replacement scenario.

### Slice 5 — Inspectable API and UI

- Expose draft review/promotion, conversion preview, brief, selection decisions,
  budget failures, render metrics, and audit lifecycle through owning routes and
  Profile/Materials components.
- Exit: browser interactions preserve manual editing, explicit acceptance,
  optimistic conflict handling, accessibility, and context boundaries.

### Slice 6 — Cumulative synthetic end-to-end proof

- Exercise capture, promotion, selectivity, generation, rendering, user edit,
  rejection, cancellation, stale conflict, and accepted-artifact retention
  through a real temporary SQLite database, API, worker, and browser.
- Exit: applicable Tier 3 review and QA pass on the exact candidate with no
  unresolved Blocker or High finding.

## 10. #902 Shipped Aid And Retained Prerequisite

The optional aid shipped through #956/#978 and its semantic authority changed
with #1064. The prerequisite remains a boundary for that aid, independent of
the unimplemented evidence-interview flow:

- load the canonical saved `ProfileSnapshot`; never use raw browser form state;
- bind the transient suggestion set to `profileVersion`;
- reference only valid experience, achievement, and skill evidence IDs from
  that snapshot;
- classify direct versus adjacent, retain supported track and seniority, and
  reject unknown evidence, fabricated roles, cross-track output, or unsupported
  intent;
- exclude contact, EEO, compensation, attestation, raw PDF, and profile content
  from logs;
- let the user edit, reject, or select suggestions; only selected acceptance
  enters the normal profile save path with `expectedProfileVersion`;
- append and case-insensitively deduplicate roles without replacing existing
  target values; and
- leave manual entry and immutable in-flight search plans unchanged.

Current canonical facts are sufficient input for this optional aid. A role
suggestion remains a proposal, does not satisfy missing-evidence questions, and
does not substitute for the exhaustive inventory or Resume Brief.

## 11. Documentation And Completion

Each implementation slice updates the owning Candidate Profile, Materials,
API, architecture, safety, and QA documents with behavior that actually ships.
Requirements or architecture decisions change only after the corresponding
contract is accepted.

This proposal is complete when its review resolves the policy model, evidence
sufficiency, promotion transaction, lens semantics, configurable budget
measurement, durable and version-scoped evidence identity, audit ownership,
the residual Tailor inventory/disposition, delivery slices, and #902
prerequisite. Product
delivery remains incomplete until all authorized slices pass their stated
review and QA gates, the Tailor disposition table has repository-wide call-site
evidence, and the plan is moved to `implemented/` with exact PR and deviation
evidence.
