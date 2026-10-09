# Employer Analysis & Materials Audit

Materials turns job evidence and profile facts into generated artifacts, then
proves what each rendered claim came from. Generation mechanics and response
schemas live in the [Tailoring Contract](tailoring.md); this page owns the audit
model.

**Read this if** you are changing employer analysis, provenance, fabrication
checks, voice, coverage, interview prep, or the artifact inspector.

## At A Glance

```mermaid
flowchart TB
    ANALYZE@{ icon: "tabler:search", form: "rounded", label: "Analyze<br/>employer + requirements", h: 64 }
    DRAFT@{ icon: "tabler:pencil", form: "rounded", label: "Draft from<br/>profile evidence", h: 64 }
    GATES@{ icon: "tabler:shield-check", form: "rounded", label: "Validate<br/>provenance + truthfulness", h: 64 }
    VOICE@{ icon: "tabler:message", form: "rounded", label: "Optional<br/>voice pass", h: 64 }
    AUDIT@{ icon: "tabler:file-search", form: "rounded", label: "Re-check<br/>rendered text", h: 64 }
    READ@{ shape: "docs", label: "Persist artifacts<br/>+ audit projections" }

    subgraph GENERATE["Grounded generation"]
      direction LR
      ANALYZE -->|requirements| DRAFT
      DRAFT -->|candidate text| GATES
    end

    subgraph ACCEPT["Artifact acceptance"]
      direction LR
      VOICE -->|rendered candidate| AUDIT
      AUDIT -->|accepted artifact| READ
    end

    GATES -->|accepted draft| VOICE
```

The invariant is simple: the text audited for provenance and coverage is the
same text rendered into the accepted artifact.

## Canonical Employer Analysis

A parallel Claude, Codex, and Google analysis ensemble produces drafts; a
provider-neutral synthesizer reconciles healthy legs through any ready
provider. One failed optional leg records degraded audit data without cancelling
the others. A single ready provider is sufficient; all-provider failure is a
hard error.

The canonical, generation-versioned analysis stores:

- role framing, inferred seniority, and the ideal-candidate narrative;
- must-have/nice-to-have requirements with priority weights;
- reasoned keywords linked to requirements; and
- quoted posting evidence for every claim, plus per-leg output/failure and
  agreement metadata.

Agreement is diagnostic. A single surviving draft records no comparison and
makes no agreement call. With multiple drafts, a model compares their meaning;
an unavailable agreement call records its safe failure without blocking an
otherwise verified canonical analysis.

### Grounding Gate

Code checks requirement/evidence ID membership and verbatim employer spans. Every draft and synthesis receives source-bound claim verification, including candidate facts and process narration. The separate model quality judge remains where used. There is no process-subject grammar, protected-class phrase screen or fabrication lexicon. Job interpretation records requirement scope and protected-class flags before consumers use the analysis. Invalid or unsupported output enters repair/failure without replacing accepted analysis.

### Reuse And Lifecycle

Analysis is cached by posting snapshot, prompt version, and SDK-set version.
Re-tailoring reuses that record; an explicit force recompute writes a superseding
generation instead of deleting history. `AnalyzeJobUseCase` can run as the first
tailoring step or through the standalone `analyze_job` method. Prompt
`employer-analysis-v4-determinations` fences every active analysis read, including
projections, interview context, review and cache reuse. Older generations remain
untouched as history and cannot become current inputs; absent current analysis
requires a new determination. Both projection builders rebuild older cached
analysis shapes by prompt version even when all events are already folded.
The native v13 cutover withdraws those cached shapes, and API reads enforce the
same version boundary. Canonical history and accepted artifacts stay intact.
Even a same-version cache hit is checked for
invalid candidate prose before reuse. A standalone `analyze_job` request with
`tenantId`, `jobId`, and `force: true` regenerates one affected analysis. Failed
validation or provider execution leaves the last accepted generation intact.

## Per-Line Provenance

Every rendered experience bullet, executive-profile line, and skill line gets a
stable provenance row. It records:

- section and rendered text;
- source profile fact and canonical evidence IDs;
- verifier-declared served requirement IDs and generation-time source anchors;
- a closed transform type and control rule; and
- a human-readable rationale.

The builder operates on the selected candidate's rendered text. Evidence and
requirement identifiers are real foreign keys, not model-authored labels. An
accepted generation writes provenance transactionally with its artifacts; a
failed or forced generation never destroys the previous accepted rows.

## Source-Bound Claim Verification

A strict model determination extracts each final proposition, classifies candidate fact/hypothetical/target-role/employer/advice, and judges support from allowed evidence. Findings cite exact line IDs and verbatim spans. Code verifies IDs, quotes and exact values; it does not classify English. Generators record anchors and the verifier affirms source contributions. Resume, cover letter, outreach, interview and analysis use the shared port, with separate artifact quality review. Failed refreshes preserve accepted artifacts. See [Tailoring Contract](tailoring.md#validation-layers).

## Stored Interview Preparation

Materials owns explicit, job-scoped interview preparation and independently
revisioned personal notes. Operations owns reads; `/interviews` is a composing
view, not a new bounded context. Public authored guidance, generated outlines,
and user statements keep separate authority and lifetimes.

### Shared Catalog Authority

The canonical authored package is
[`docs/research/interview-preparation/`](../research/interview-preparation/README.md).
Its checked structured metadata assigns stable IDs, responsibility/competency
tags, role lenses, answer formats, and source relationships. The deterministic
compiler emits one tracked `jobctrl/assets/interview/catalog.v1.json`; both
Python and TypeScript load that same packaged asset. Production never infers
role applicability from prefixes/titles or parses prose headings at runtime.
Installed loaders require the payload asset and fail closed when it is absent;
repository docs and plugins are not fallbacks.

The catalog carries schema/catalog revisions and a semantic `catalogDigest`;
raw-byte SHA-256 is a separate packaging equality check. Cards and rubrics have
independent revisions/digests. All 121 active cards remain `research_draft`.
C08 stays reserved/retired. Source records expose actual reading coverage and
attribution kind: direct interview guidance, practice extrapolation, or
editorial synthesis. Guidance and rubric anchors do not establish author
endorsement, personal factual support, readiness, or validated assessment.

### Selection, Evidence, And Acceptance

Explicit selection accepts 1–16 unique active question IDs. Catalog, ownership,
profile version and the per-question eight-evidence limit are checked before
spending. Omitted selections use a cached model selection determination.
Evidence relevance and direct versus transferable support also come from a
model determination. An explicit empty evidence selection remains empty.

Each question is drafted separately with only its selected canonical evidence.
The drafting prompt contains no other question's personal evidence. Structured
parsing checks IDs and the declared support/ID shape. A separate claim-verifier
call determines the meaning and support of every final line, including headings,
gaps and probes. It cites line IDs and evidence spans. The existing quality
judge remains a separate call. C07 negotiation guidance has its own semantic
rubric; code never infers speech acts, personal authority, salary guidance or
hypothetical status from grammar.

The immutable generation context records the profile, analysis, fit, catalog,
selected evidence and determination IDs. Accepted material inputs use registered
artifact bindings and byte hashes. Notes and new recollections cannot supply
confirmed personal facts. Failed refreshes preserve accepted preparation and
independently revisioned notes. The activity owns calls, lane accounting,
heartbeats and retries; completed-run reuse spends nothing.

### Immutable Inputs, Independent Notes

`generationContext` preserves the catalog binding and selected-card snapshots,
selected IDs/order/reasons and per-question evidence-selection mode/ordered IDs,
profile ID/version and relevant evidence excerpts,
job title/company/description excerpt and the full canonical description hash,
employer-analysis binding plus relevant role/requirement excerpts, fit status,
approved-material references/hashes, context digest, and model/prompt/gate
versions. A profile version alone cannot
reconstruct a historical snapshot, so relevant generation-time data is retained.
Older prep remains inspectable when current inputs change. Current-state reads
derive stale reasons without rewriting the stored context; regeneration is
explicit.

Accepted, failed, and superseded generations remain history. Replacement is
accepted only after its owning gates and persistence succeed; pending or failed
refreshes leave the prior accepted prep visible. Existing theme/STAR/gap/company
items remain readable as explicitly unbound legacy output, with no fabricated
question or rubric association. Both projection builders carry the same
nullable context and question metadata.

User notes are tenant/job/question scoped, independent of item replacement, and
append revision history with an expected-revision comparison. A conflict cannot
overwrite a newer edit. Input cannot self-declare supported factual status;
new recollections default to `unverified_user_statement`, and `user_edited`
notes never inherit the generation audit. A source generation must retain the
same selected question; the server derives its catalog/card/context bindings
and rejects inconsistent client claims. An independent note carries no
generation context. Those bindings explain the draft's origin without promoting it to
Profile. Generation and note saving change no profile, fit, Discovery, approved
resume, or Apply state.

Ordinary edits preserve a valid origin. If its generation was deleted, the new
revision detaches to independent provenance while the archived revision keeps
its original binding; a newer prep never becomes the note's implicit origin.

Prep uses exact-schema v12; [Storage](storage.md) owns the stopped candidate
migration, admission, preservation, and rollback contract. Runtime startup does
not silently mutate a real database. Notes follow the job graph's tenant and
purge lifecycle. Private text remains at the canonical owner; generation and
note events contain safe IDs, versions, timestamps, and counts only. See the
[read-model contract](read-model.md#interview-preparation-and-notes) and
[complete API contract](../api/complete-contract.md#interview-catalog-preparation-and-notes).

Post-interview reflections remain manual Apply outcomes linked to a prep
generation. Reusable preparation without a job, typed rehearsal, calibrated
grading, and live assistance are future work. There is no practice-attempt,
transcript, microphone, streaming, or in-session state in this release.

## Voice Pass And Final Audit

A model chooses voice changes using stable line IDs. Any changed artifact receives fresh claim verification and separate quality review, plus the six-persona determination for a high-fit resume. Typed verdicts decide adoption; buzzword and structural-variety proxies are removed. An optional rewrite provider or shape failure records a rejected attempt and retains the already-verified candidate. Verification failures for changed text block the refresh. Accepted final text, source anchors and determination IDs commit together. Requirement coverage is arithmetic over verifier-declared served requirement IDs, never keyword appearance.

## Tailoring Explanation Read Model

Artifact projections expose validation/judge metadata plus canonical
provenance, coverage, and voice columns. A PDF resolves those audit fields from
its sibling tailored-resume row because both represent the same generation.

Job Detail and Artifact Detail resolve stored profile-evidence foreign keys
through the canonical Evidence Map read model before rendering them. A resolved
reference shows the evidence title plus a bounded outcome/action/scope excerpt;
Artifact Detail links to the owning Evidence entry. A missing legacy reference
renders an explicit unavailable state and keeps the raw key behind a technical
disclosure. The read layer does not invent a title, hide the missing reference,
or present a storage key as meaningful evidence.

Apply Review and Artifacts compare only stored audit data: coverage buckets,
template metadata, validation/judge fields, and review risk labels. If either
artifact lacks coverage, the UI reports `coverage not recorded`; it does not
turn missing audit data into zero coverage.

Requirement fit in Job Detail and Apply Review must belong to the current
employer-analysis generation and match both requirement ID and full text
(ignoring whitespace differences). Accepted-resume coverage has an independent
binding: the selected artifact's canonical `quality_plan.requirement_directives`
must record that ID and text, and its own artifact ID must own the bullet
provenance. A material generation number is not an analysis generation number.
Missing, duplicate, or changed source identities show `coverage not recorded`;
a fresh fit report cannot authorize unrelated evidence in an older resume.
These read guards preserve accepted artifacts and their original audit history.

Shared Python/TypeScript parity fixtures seed scores, stages, analysis,
provenance, and artifacts, then compare every dual-written projection column and
JSON shape. That is the drift guard for what the inspector displays.

## Reviewed Locale Variants

Materials also owns source-linked translations of accepted resumes and cover
letters, separate from application approval. The separately versioned contract
uses the existing schema-14 artifact registry and semantic determination bindings;
it does not replace source generations or require a companion branch. See
[Material Locale Variants](material-locale-variants.md) for authority, independent
reviews, version fences, failure preservation and export ownership.
