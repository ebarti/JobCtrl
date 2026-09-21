# Profile Evidence And Selective Resume Composition

> **Status:** Proposed, unshipped, and awaiting explicit user approval.
> Merging this plan records a reviewable design; it does not authorize the
> implementation slices below or change existing profile, import, Tailor, or
> artifact behavior.
>
> **Owner:** [#883](https://github.com/ebarti/JobCtrl/issues/883). Optional
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
It defines the evaluation needed to choose configurable defaults. It does not
run interviews, rewrite existing profiles, re-tailor accepted artifacts, or
ship the planned product behavior.

## 2. Confirmed Baseline

This plan was reconciled against `main` at
`6a82c233c434e67f0a2d1c6df3db6aa68d036b75`.

- Resume import currently marks every imported experience, education, and
  skill category as required in `profile_import.py`.
- The Profile aggregate treats empty required-entry lists as all entries. Empty
  pins therefore have established legacy semantics and cannot be reinterpreted
  as “select freely” in place.
- The canonical Candidate Profile already has a monotonically advancing
  version and immutable `ProfileSnapshot` readers.
- The browser-facing profile response does not expose that version, and the
  normal profile write route has no expected-version comparison.
- Profile/version rows and the `ProfileUpdated` event commit atomically in the
  TypeScript write transaction. Continuation intent, dispatch, and acknowledgement
  use the existing recoverable post-commit path; they are not part of that row
  transaction.
- Materials already have typed achievement evidence, requirement planning,
  grounding and fabrication gates, evaluated candidates, canonical batch
  ownership, deterministic assembly, rendered PDF inspection, and preservation
  of the last accepted artifact.
- [#830](https://github.com/ebarti/JobCtrl/pull/830),
  [#868](https://github.com/ebarti/JobCtrl/pull/868), and
  [#869](https://github.com/ebarti/JobCtrl/pull/869) are merged foundations.
  This program extends their contracts rather than building a parallel
  generation or retry path.

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

- Existing profiles remain `legacy_all`. Existing empty pins continue to mean
  all entries, and existing explicit pins retain their current meaning.
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

### 4.1 Draft model

An `EvidenceCaptureDraft` is private, local, and separate from normalized
profile tables. It contains:

- draft ID and draft revision;
- base profile version;
- source records with source type, stable source identifier, captured time,
  ownership, and bounded source excerpt or user-authored answer;
- proposed facts and their candidate target paths;
- supporting and contradicting source references;
- unanswered questions and explicit “unknown” values; and
- review state: `unreviewed`, `needs_evidence`, `contradicted`, `accepted`, or
  `rejected`.

Draft answers remain local profile data. They never appear in issue comments,
fixtures, telemetry, prompt logs, or public documentation.

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
from a generic interview script. The deterministic planner asks the smallest
useful question first:

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

### 4.4 Promotion transaction

Promotion submits the selected draft items, their accepted normalized values,
the draft revision, and `expectedProfileVersion`. The owning Profile use case
checks the current profile version in the same transaction that writes the
normalized rows, advances the profile version, records provenance and
acceptance, and records the `ProfileUpdated` event. After commit, the existing
recoverable continuation path records intent, dispatches preparation, and
acknowledges or retries it. A mismatch returns a typed stale conflict with no
profile row, evidence row, event, continuation intent, or dispatch work.

If the profile advanced, the draft is rebased for review. Unaffected proposals
may be retained; overlapping accepted values, removed targets, and newly
contradicted proposals require another explicit decision.

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

The program will choose shipped defaults only after comparative evaluation on
the synthetic cohorts in section 8. Defaults may vary by lens, template, paper
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
2. deterministically select the candidate evidence set within the budget;
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

## 8. Evaluation And Synthetic Fixtures

All fixtures contain invented people, employers, evidence, and jobs. No real
profile, resume, interview answer, database, PDF, or generated material may be
copied into tests or issue discussions.

| Fixture | Required observation |
| --- | --- |
| Sparse profile | Missing facts stay missing; useful questions appear; unsupported claims are not promoted or generated. |
| Long varied history | Global budgets select a coherent narrative and record every omission without losing unique older evidence. |
| Achievement-dense role | Independent global and per-role achievement budgets cap selected evidence even when several achievements could be compressed into fewer bullets. |
| Cross-role evidence pressure | Comparative runs vary achievement and bullet budgets independently and report the exact infeasible dimension instead of silently dropping coverage. |
| Executive history | Executive lens emphasizes supported organizational and business outcomes. |
| Staff/Principal history | Technical lens emphasizes supported architecture, tradeoffs, system outcomes, and influence. |
| Dual-track history | Each lens produces a distinct brief from the same evidence without inventing intent. |
| Contradictory evidence | Promotion and artifact use fail closed until the contradiction is resolved. |
| Explicit pins | Pins survive ordinary budgets or produce `artifact_budget_infeasible`. |
| Infeasible budget | No candidate is accepted and the exact constraint conflict is inspectable. |
| Older unique relevance | Older evidence remains selectable and truthful chronology is preserved. |
| Failed/rejected replacement | The prior accepted artifact remains current and the failed attempt remains auditable. |
| Post-voice budget regression | The final candidate is remeasured and rejected or repaired within the same bounded owner. |
| User edit | Grounding, artifact metrics, and skim status are invalidated and recomputed from the edited artifact. |

Comparative evaluation measures evidence validity, contradiction handling,
requirement coverage, unsupported-claim rate, forced-content feasibility,
actual word/page/role/bullet/skill outcomes, planned and actual selected
achievement totals and per-role distributions, skim-quality rubric results,
lens distinctness, acceptance rate, bounded cost, latency, cancellation, and
accepted-artifact retention. Comparative matrices vary global achievement,
per-role achievement, global bullet, and per-role bullet limits independently.
Numeric defaults require recorded cohort evidence and explicit user approval
before becoming product policy.

## 9. Dependent Delivery Slices

Each slice is a separate reviewable PR based on the preceding unmerged slice.
Later slices do not ship around an unaccepted contract.

### Slice 1 — Contract and evaluation groundwork

- Add versioned draft, promotion, selection-policy, brief, budget, decision,
  metrics, skim, and audit schemas.
- Add synthetic cohort builders and deterministic contract/evaluation tests.
- Add backward-compatible browser/API profile-version reads and the evidence
  reference contract required by #902.
- Exit: legacy reads remain valid; unknown evidence and stale version tests fail
  closed; proposed defaults remain absent.

### Slice 2 — Draft capture and canonical promotion

- Add Profile-owned draft repository/use cases, question planner, provenance
  and contradiction UI, and atomic expected-version promotion.
- Exit: accepted items alone enter canonical rows and emit the normal profile
  event; rejection, conflicts, and stale saves cause no canonical mutation,
  profile event, continuation intent, or dispatch work.

### Slice 3 — Selectivity, rendering, and artifact audit

- Add explicit `selective_v1` conversion, inventory, Resume Brief, narrative
  planning, budget enforcement, deterministic selection/assembly, actual
  render metrics, skim checks, and persisted audit.
- Reuse #830 achievement fidelity and #868/#869 batch/candidate ownership.
- Exit: text, HTML, and PDF reconcile to the same selected evidence and the
  last accepted artifact survives every failed replacement scenario.

### Slice 4 — Residual Tailor inventory and disposition

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
  acceptance fence. Resolve the current unbounded voice-adapter contract so a
  late voice result cannot exceed the selected candidate budget or replace the
  last accepted artifact.
- Exit: repository-wide call-site evidence proves that each entry point and
  loop has one named owner and recorded disposition; deleted paths have no live
  callers; retained paths share the canonical batch, cancellation fence,
  budget, audit, and accepted-artifact rules.

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

## 10. #902 Target-Role Suggestion Prerequisite

#902 may proceed before the complete evidence-interview flow only through this
bounded contract:

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
evaluation, durable and version-scoped evidence identity, audit ownership,
the residual Tailor inventory/disposition, delivery slices, and #902
prerequisite. Product
delivery remains incomplete until all authorized slices pass their stated
review and QA gates, the Tailor disposition table has repository-wide call-site
evidence, and the plan is moved to `implemented/` with exact PR and deviation
evidence.
