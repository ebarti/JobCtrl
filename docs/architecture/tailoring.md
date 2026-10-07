# Tailoring Contract

Tailoring generates a selective resume from saved profile sources and the current employer analysis/requirement-fit ledger. [Semantic Judgments Are LLM Determinations](../decisions.md#2026-10-07-semantic-judgments-are-llm-determinations) defines model authority. [Materials Audit](materials.md) owns shared truthfulness and line provenance.

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
5. Verify final claims and provenance with the model, then judge artifact quality separately.
6. Repair from model findings within the attempt budget. No lexical gate or score cutoff replaces the verdict.
7. If voice is requested, the model chooses wording changes; changed text receives fresh claim verification and quality review.
8. Commit the accepted generation and audit together. A failed attempt cannot replace the accepted resume/PDF or its approval.

## Inputs To Tailoring

Inputs are versioned profile facts and confirmed evidence, canonical posting text, accepted job interpretation, employer requirements, model-backed requirement-fit verdicts and user-authored selections/policy. Unconfirmed evidence cards, interview notes and new recollections do not become facts. The prompt does not dump credentials or unrelated private profile fields.

## The Actual Model Prompt

Prompts contain minimized canonical source IDs/text, allowed mappings, artifact constraints and repair findings. All source text is untrusted data. Lane binding and BR-050 preflight precede calls; envelopes record schema/prompt versions, provider/model and input fingerprint.

## Output Schema

`GeneratedResumeDraft` contains explicit summary sentences, experience updates, skill updates and `generated_claim_mappings`. Each mapping records a line ID, location, evidence/requirement IDs, transform and rationale. Code rejects foreign IDs, duplicate IDs and locations that do not map to the shipped line. The verifier cites exact final text and sources; generator assertions alone never establish support or coverage.

## What "Profile-Row Based" Means

Authored experience, education and skill rows remain canonical. Exact row IDs control selection and rendering. Reframing prose requires source-bound model verification; immutable employer/title/date fields retain literal binding. Selection does not convert a draft evidence card into confirmed history.

## Tailoring Plan

`target_seniority` comes from the accepted job interpretation. Requirement scope and protected-class flags come from that interpretation, without regex overrides or old-analysis fallbacks. `required_evidence_ids`, selections and budgets are structural/user authorities. Requirement-fit evidence IDs must belong to the supplied profile inventory. No substring “seniority signal” or token overlap adds evidence or coverage.

## Attempt Loop And Candidate Selection

A generated candidate must pass structural binding, claim verification and the separate quality judge. Model findings supply repair reasons and exact line IDs. Arithmetic may compare accepted typed fit results; it does not assess prose. Provider, spend, JSON, schema and source-binding failures remain distinct and preserve accepted material.

## Validation Layers

### 1. Structured Output Schema

Strict schemas reject extra fields, unknown enums and missing inventory items.

### 2. JSON Field Validation

Code validates row/line membership, immutable fields, explicit selections and numeric/date/currency binding. Self-talk, named-technology claims and register are model decisions.

### 3. Resume Assembly

Rendering preserves stable line IDs through text, HTML and PDF layout boxes. No reader reconstructs sources by matching strings.

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
