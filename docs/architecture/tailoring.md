# Tailoring Contract

Tailoring generates a selective resume from saved profile sources and the current employer analysis/requirement-fit ledger. [Semantic Judgments Are LLM Determinations](../decisions.md#_2026-10-07-semantic-judgments-are-llm-determinations) defines model authority. [Materials Audit](materials.md) owns shared truthfulness and line provenance.

## The Contract At A Glance

| Work | Authority |
| --- | --- |
| Candidate fact, seniority, relevance, prohibited claim, voice and self-talk meaning | Structured model determination |
| Posting seniority and requirement scope | Accepted job interpretation |
| Artifact support | Separate claim-verification determination |
| Quality acceptance | Independent quality-judge verdict |
| IDs, verbatim quotes, exact numbers/dates/currency, schema, fences | Code |
| Fit bands, weights and caps over typed requirement verdicts | Code |
| Line-to-source and line-to-finding display | Persisted ID joins |

Provider availability never selects a lexical path. A blocked refresh retains the last accepted generation and records its safe failure code.

## Short Version

Canonical facts enter bounded prompts by ID. The generator returns strict JSON with explicit line anchors. The claim verifier independently reads the final lines and affirms their sources, claims and served requirements. The quality judge returns a separate typed verdict. Repair consumes the cited reasons; acceptance commits bytes, provenance and determination references together.

## End-to-End Flow

1. Load the saved profile version, employer-analysis generation, accepted job interpretation, requirement-fit report and confirmed tailoring policy.
2. Build the artifact budget, required selections and allowed evidence inventory. Structural infeasibility is actionable; code cannot silently drop pinned evidence.
3. Generate strict line/claim mappings tied to known source and requirement IDs.
4. Assemble and check format, IDs, immutable fields and exact values.
5. Verify final claims and provenance with the model, then judge artifact quality separately. High-fit resumes (normalized fit at least 0.8) retain a separate, cited six-persona review. Its typed verdict decides acceptance; the persona score is diagnostic.
6. Repair from model findings within the attempt budget. No lexical gate or score cutoff replaces the verdict.
7. If voice is requested, the model chooses wording changes; changed text receives fresh claim verification, quality and applicable persona review. An optional rewrite provider or shape failure records a rejected voice attempt and retains the already-verified candidate. A failure of verification for changed text blocks that refresh.
8. Commit the accepted generation and audit together. A failed attempt cannot replace the accepted resume/PDF or its approval.

## Local Application Boundary

`scoring/tailor.py` resolves configured model choices and explicit request
overrides into the frozen `TailoringLlmPolicy` before constructing
`TailorResumeUseCase`. The use case requires this value; it never reads ambient
configuration. Saved profile controls and versioned policy history remain
canonical inputs, with the existing profile/policy fence at generation commit.

An explicit manual materials request carries its existing low-fit exception
through both Tailor and Cover activity payloads to their canonical per-job
admission checks. Default and legacy payloads keep the ordinary score floor.
The exception changes only the numeric threshold for that request; hard
eligibility blockers, current-score and posting checks, artifact ownership,
attempt limits, claim verification and quality review still apply. PDF exports
consume the accepted materials without changing the score or global policy.

Preparation targets carry the latest canonical Score grade and version, joined
by tenant and JobId. The legacy grade on `jobs` cannot choose review behavior.
The target passes its saved grade to the resume review gate, so a
normalized fit of at least 0.8 receives its independent six-persona review.
A manual low-fit exception leaves that grade unchanged. Unscored targets remain
readable for scoring; material admission still requires a current Score.

The generation graph distinguishes selected achievements from canonical
context. Its `required_generated_evidence_ids` manifest requires selected
achievement claims and explicit user pins. Role dates, role metadata, education,
skills and baseline context remain available sources without forcing them into
new summary prose. This structural ownership flag does not decide relevance or
grant shipped coverage: the final model verifier must affirm every declared
source contribution and served requirement. Unused context cannot become an
extra provenance anchor, and an unrepresented context edge receives no automatic
generated-coverage credit.

An overflowing seeded graph is still an evidence menu. If explicit user pins
fit but the seeded selection exceeds a saved per-role bullet ceiling, Materials
requests a `material_evidence_selection` determination from the configured
generator route before drafting. It selects only admitted requirement/evidence
edges, cites their canonical sources, and records a reason for each requirement
left uncovered. Code enforces exact IDs, pins and the unchanged ceiling; the
existing artifact-budget guard runs again on the selected plan. The plan audit
stores the determination ID. Feasible seeds make no additional call, impossible
pins still block before spend, and failed selection preserves accepted materials.
Selection never establishes shipped coverage or replaces independent reviews.

Exhausted factual or quality correction returns the non-retryable
`material_rejected` error. It preserves the rejected audit and last accepted
artifacts; Temporal does not restart the whole correction budget as though a
provider transport had failed. Provider/network faults retain their separate
transient retry behavior. A new explicit request can use the existing recovery
controls after the owner addresses the recorded finding.

Selected Tailor and Cover cohorts isolate typed per-job prerequisite failures
that occur before a stage claim. Missing inputs skip that member, and temporary
source unavailability remains a bounded item error while healthy peers finish.
This boundary does not claim or terminalize an unowned stage. Cancellation,
spend-budget failures and unclassified exceptions still propagate; accepted
artifacts and the existing ownership fences remain authoritative.

The effective judge model binds the claim-verification and quality/persona
adapters, independently of the generator model pool. Default review shares the
operation's default adapter. An explicit reviewer selection binds that route
and records its actual provider/model; unavailability fails visibly without
substituting the generator adapter. Explicitly injected review ports retain
their own authority and are not replaced by composition.

The same composition root injects `ArtifactTextWriter`, implemented locally by
`LocalArtifactTextWriter`. This small capability creates directories, writes exact
UTF-8 text and reports its byte size. The use case retains candidate selection,
rejected-candidate inspection content, generation filenames and side-file
formatting. Validation, selection, evidence construction and aggregate transitions
do not perform file I/O. The writer does not register or accept artifacts:
`MaterialsRepository` registers the generation and `UnitOfWork` preserves the
atomic acceptance/provenance transition. `PdfRendererPort` still renders before
that transition. Candidate write errors propagate before acceptance; diagnostic
`_JOB.txt` and `_REPORT.json` writes remain best effort after persistence.

## Inputs To Tailoring

Inputs are versioned profile facts and confirmed evidence, canonical posting text, accepted job interpretation, employer requirements, model-backed requirement-fit verdicts and user-authored selections/policy. Unconfirmed evidence cards, interview notes and new recollections do not become facts. The prompt does not dump credentials or unrelated private profile fields.

## The Actual Model Prompt

Prompts contain minimized canonical source IDs/text, allowed mappings, artifact constraints and repair findings. All source text is untrusted data. Lane binding and BR-050 preflight precede calls; envelopes record schema/prompt versions, provider/model and input fingerprint.

## Output Schema

`GeneratedResumeDraft` contains explicit summary sentences, experience updates, skill updates and `generated_claim_mappings`. Each mapping records a line ID, location, evidence/requirement IDs, transform and rationale. Code rejects foreign IDs, duplicate IDs and locations that do not map to the shipped line. The verifier cites exact final text and sources; generator assertions alone never establish support or coverage.

Generation describes the renderer's literal bindings: every summary sentence
uses `executive_profile#0`, bullet N uses `experience:<entry-id>#N`, and a selected
skill group uses `skills:<category-id>#0`. The prompt supplies the exact evidence
IDs belonging to each experience entry. The response schema permits only claim
labels allowed by the active claim policy; validation independently enforces the
same policy and checks every emitted binding.

## What "Profile-Row Based" Means

Authored experience, education and skill rows remain canonical. Exact row IDs control selection and rendering. Reframing prose requires source-bound model verification; immutable employer/title/date fields retain literal binding. Selection does not convert a draft evidence card into confirmed history.

## Tailoring Plan

`target_seniority` comes from the accepted job interpretation. Requirement scope and protected-class flags come from that interpretation, without regex overrides or old-analysis fallbacks. `required_evidence_ids`, selections and budgets are structural/user authorities. Requirement-fit evidence IDs must belong to the supplied profile inventory. No substring “seniority signal” or token overlap adds evidence or coverage.

## Attempt Loop And Candidate Selection

A generated candidate must pass structural binding, claim verification and the separate quality judge. Model findings supply repair reasons and exact line IDs. Arithmetic may compare accepted typed fit results; it does not assess prose. Provider, spend, JSON, schema and source-binding failures remain distinct and preserve accepted material.

For each cover-letter draft, factual verification and quality review read separate
copies of the same frozen lines, sources and rubric. The production runner overlaps
these independent calls in the bounded [letter-review pool](pipeline/concurrency.md).
Both durable results join before acceptance or an ordered correction. Review IDs,
cache fingerprints, model/effort, citation validation and attempt budgets stay the
same. Resume checks retain their dependencies on factual grounding and pruning.
Custom directly injected reviewers and in-memory repositories run sequentially.

Each bounded resume or cover correction carries an ordered review history:
recorded determination IDs and their complete typed quality/persona results.
Later generators and reviewers receive that history, including after a changed
voice proposal. The reviewer considers earlier repairs and explains any reversal
with a feasible correction addressing the competing concerns. Its independent
typed verdict still decides acceptance; history cannot force a pass or expand
generation permissions.

History is context, never an additional factual or citation source. Current
canonical sources and rendered lines retain their exact ID/quote fences. The
history participates in determination fingerprints, so changed review context
requires a new decision while unchanged factual inputs can reuse verification.
Resume attempt audits retain per-candidate and final review context; cover
artifact metadata retains the history supplied to its final review. Rejected
voice review context remains in the voice audit. Existing attempt/spend limits
and accepted-artifact preservation apply unchanged.

Quality and persona reviewers receive the canonical posting plus the same user
generation permissions, required roles, bullet limits and current coverage plan
as the generator. Their shared rubric also carries the exact canonical evidence
IDs eligible for a bounded revision. Review requests cannot authorize a new
coverage edge or expand the artifact budget. A required role without active
coverage or a bullet pin retains its single positioning-bullet constraint;
additional saved evidence outside the permitted revision set cannot become an
impossible drafting requirement.
Quality correction IDs are checked against admitted revision targets plus
canonical sources already bound to the verified rendered candidate. The full
profile remains available for factual review; its mere presence cannot grant a
new coverage edge. An out-of-scope correction gets exact private ID feedback in
the existing bounded repair, without changing the model's quality verdict.
Review permissions also record renderer-owned layout and the exact fixed skill
category order. Skill-item reordering never grants category or section-layout
edits; those remain under the saved profile and template.
Seniority does not imply direct reports, and omitted optional roles alone do not
require a complete career inventory. Reviewers assess the truthful artifact;
unsupported qualification gaps remain gaps rather than requests to invent proof.
Repairs receive the rejected typed candidate and exact unaffirmed source IDs as
untrusted data, with the current source and coverage allowlists remaining authoritative.

## Validation Layers

The canonical contact formatter keeps professional-link destination hosts and
paths visible in both text and PDF labels. Two platforms may use the same
handle; display text must still distinguish the saved links while preserving
their exact hyperlink targets. Generated edits do not change contact facts.

### 1. Structured Output Schema

Strict schemas reject extra fields, unknown enums and missing inventory items.

### 2. JSON Field Validation

Code validates row/line membership, immutable fields, explicit selections and numeric/date/currency binding. Self-talk, named-technology claims and register are model decisions.

### 3. Resume Assembly

Rendering preserves stable line IDs through text, HTML and PDF layout boxes. No reader reconstructs sources by matching strings.

The shared HTML print renderer repeats the selected template padding on every
physical page fragment. A4 and Letter continuation pages retain their top and
bottom insets without shrinking the font or changing accepted text. Section
headings stay with their following content across a page break. Content
may still flow onto another page; inset preservation does not impose a page
count or establish the accuracy of the pre-print layout-box approximation.

### 4. Rendered Resume Validation

Sections, layout and quote existence are mechanical. Meaning is assessed against actual final text.

### 5. Structural Tailoring Checks

Required IDs, pins, artifact budget and exact-value checks remain code. Representation of an achievement, seniority alignment, stuffing and style remain model judgments.

### 6. Claim Verification

Every final line receives a typed verdict, factual propositions, verbatim supporting evidence, source contributions and findings. Unsupported/uncertain factual claims fail. Generation anchors must reconcile with verifier-affirmed source IDs. The technology/title/employer lexicons and stemmer are deleted.

### 7. Post-Generation Fit Gate

Coverage counts only requirements the verifier declares served by shipped line IDs. The requirement-fit policy owns arithmetic and bands over those typed verdicts. No keyword union launders provenance.

### 8. Structured Judge

The existing quality judge remains a separate call. Its typed pass/fail verdict controls quality acceptance; scores are diagnostic rather than a semantic threshold.

### 9. Adversarial Review

Any additional model review uses canonical sources, explicit line IDs and strict findings. Code never reclassifies its prose by keywords.

### 10. Optional Voice Pass

The model chooses prose changes by stable line identity. Skill/structural inventories remain unchanged. Final changed lines require fresh claim verification and quality review; no buzzword density or structural-variety proxy decides adoption.

## Persistence And Audit Data

Accepted artifacts carry claim-verification and quality-determination IDs. `artifact_line_anchors` records line, evidence, requirement, transform and reason. `semantic_determinations` holds accepted envelopes; bindings fence entity versions. Blocked attempts are separate from accepted artifacts. Apply Review joins anchors/findings by line ID and displays “No recorded source” for unanchored lines.

## Deterministic Versus LLM-Owned Work

Code owns formats, identity, schema, source binding, security and arithmetic. Models own support, relevance, voice, seniority and requirement demonstration. Literal user filters remain literal. No read-side lexical matching is allowed.

## Current Constraints

A configured provider and spend allowance are required. The offline demo reports generation and verification unavailable. Catalog browsing, authored edits and historical reads remain available under their existing safety boundaries. Merge and release remain owner-authorized actions.

## Common Failure Reasons

Provider unavailable, budget denied, malformed JSON, schema violation, foreign IDs, non-verbatim quotes, mismatched values and stale source versions are distinct actionable failures. An unsupported model verdict drives repair or failure with its cited reason. A refresh never erases the accepted generation.

## How To Change Tailoring Safely

Update the owning schemas/prompts and source contracts together. Prove the model controls the result using opposite valid fake-model verdicts on the same sources. Exercise each failure without fallback, last-accepted preservation and actual product persistence. Do not add eval sets, sentence corpora, baselines or recorded-output replay fixtures.

## Outreach Draft Gates (Reused Materials Stack)

Outreach calls claim verification through a port, using confirmed contact facts and canonical profile sources. An independent quality judge assesses tone. User edits receive the same model checks before approval. The user confirms a draft and records sending separately; generation never sends a message.

## Key Code Pointers

- `domain/materials/claim_verification.py` and `domain/ports/claim_verification.py`.
- `domain/materials/artifact_quality.py`, `generation.py`, `provenance_builder.py` and `claim_grounding.py`.
- `domain/enrichment/interpretation.py`, `domain/profile/canonical_sources.py`.
- `infrastructure/determinations.py`, Materials repositories and `apps/api/src/semantic-determinations.ts`.
