# Reviewed material locale variants

Owning issue: [#1039](https://github.com/ebarti/JobCtrl/issues/1039).

This is a repository-grounded investigation and a future design for reviewed
translations of accepted application materials. It adds no translator, locale
API, language-quality gate, migration or export-equivalence guarantee.
Illustrative language pairs, such as English to Spanish, are examples rather
than a support matrix. Generation approval in the existing Materials context is
not independent human language review.

<a id="current-implementation"></a>

## Current implementation

The existing [materials audit](materials.md) and [tailoring contract](tailoring.md)
own current behavior. This investigation inspected source commit
`1ecb877dbb5275afeabfa6ca1ae872f88dbaaacb`. The source/lock manifest in the
retained evidence records exact SHA-256 hashes, including normally imported
modules; the executable probes did not replace those modules with extracted
production fragments.

### Accepted material identity and selection

[`MaterialsSet`](../../workers/automation/src/jobctrl/domain/materials/aggregate.py)
identifies a set by tenant, canonical JobId and positive generation. Its immutable
helpers enforce artifact slot types, resume-before-cover and
text-before-corresponding-PDF relationships. A resume attempt becomes approved
when content validation passes, the judge is absent or approves, and no policy
review is required. Review-required output remains a candidate; rejected output
does not become approved. The aggregate alone does not require a judge,
provenance repository, renderer or transaction. Those guarantees depend on
use-case wiring. The constructor's structural invariants are narrower than the
helpers' transition checks.

Artifact identity is separate from generation. A text artifact has its own ID,
path, format, size, status and metadata; its PDF has another ID. An approved
status is a stored domain decision, not an immutable file-content hash or proof
of manual review. The repository's raw `load` returns the latest generation;
[`load_current_approved`](../../workers/automation/src/jobctrl/infrastructure/materials/sqlite_repository.py)
instead selects the greatest generation with an approved tailored-resume row.
Rejected/in-progress generations can therefore coexist with the last approved
resume. The maximum bullet-provenance generation by itself is not an approved
material selector.

The SQLite materials repository checks next-generation allocation or matching
lineage for a same-generation update. A lineage collision cannot authorize an
unrelated writer. Same-generation saves are updates, not immutable append-only
snapshots. The investigation measures the explicit `retailor=True` path; it
does not assert preservation for arbitrary direct aggregate/repository writes
or callers overwriting files in place.

### Canonical facts, generation controls and shipped claims

[`ProfileSnapshot`](../../workers/automation/src/jobctrl/domain/profile/snapshot.py)
carries tenant/profile/version and deep-copied profile data; `as_dict` also
returns a deep copy. Derived `skills_boundary` and `resume_facts` are
compatibility views, not new fact authorities.
[`SqliteProfileRepository`](../../workers/automation/src/jobctrl/infrastructure/profile/sqlite_repository.py)
persists versioned profile state and achievement-owned evidence. Its
`candidate_profile_achievement_evidence` records retain entry ownership,
source text, action, scope, tools, metrics and outcome. Flat
`resume_constraints.real_metrics` preserves legacy values but does not replace
achievement ownership as support for a generated claim.

[`TailorResumeUseCase`](../../workers/automation/src/jobctrl/domain/materials/use_cases.py)
consumes a snapshot, canonical employer analysis and coherent requirement fit.
The posting/analysis defines target requirements, not candidate history.
[`requirement_coverage.py`](../../workers/automation/src/jobctrl/domain/materials/requirement_coverage.py)
builds the achievement/requirement graph and validates generated claim mappings
against selected evidence and policy. Coverage needs text that actually ships:
[`claim_grounding.py`](../../workers/automation/src/jobctrl/domain/materials/claim_grounding.py)
binds mapped text and locations to assembler-mirroring provenance lines. A
requirement ID alone cannot establish coverage.

[`ContentValidator` and `ResumeAssembler`](../../workers/automation/src/jobctrl/domain/materials/services.py)
check required roles, bullets, skills and content surfaces, then assemble text
from the permitted payload and canonical profile. A supplied experience title
must be empty or the exact source title. Companies, dates and education come
from profile entries. Rendering applies text sanitization/date presentation, so
this is not a claim of byte identity with every raw profile string.

The [provenance builder](../../workers/automation/src/jobctrl/domain/materials/provenance_builder.py)
mirrors shipped summary, experience bullets and skill lines, with source IDs,
evidence IDs, requirement IDs, transform/control and rationale. Policy-disabled
rewrites must not become provenance for unseen text.
The [fabrication detector](../../workers/automation/src/jobctrl/domain/materials/fabrication_detector.py)
checks numeric/date/title/employer claims and named tools against profile
sources and scoped evidence; job-target vocabulary is not candidate proof.
Structured validation, quality/judge checks, selected text, optional voice
transformation and final grounding must remain aligned. A failed voice audit
can discard the voice output and retain the clean candidate. The probes did
not enable voice or adversarial model review.

[`policy.py`](../../workers/automation/src/jobctrl/domain/materials/policy.py)
fingerprints prompt/configuration/profile-policy/custom-prompt controls and the
tailoring-relevant snapshot projection. That projection includes resume,
constraints, experience and rendering-relevant personal fields. Compensation,
work authorization and other application-only fields are excluded. The current
SQLite policy fence compares the saved profile's relevant fingerprint and
current policy inside an active unit of work. It is not simply a comparison of
profile version numbers.

The existing `adjacent_translation` label is a **claim-policy concept** for
adjacent achievement framing, alongside `verified_only`,
`evidence_reframing` and `draft_requires_confirmation`. Its auto-approval
controls and review requirements do not specify source/target language,
terminology, a translator or language-equivalence review.

### Replacement and failure preservation

The selected candidate's evaluated text is persisted directly; a later assembly
must not diverge from its audit. Replacement PDF rendering happens **before**
the short database generation flip. On render failure, a rejected attempt is
saved without superseding the prior approval or publishing a replacement
approval. Failed candidate/provider attempts retain audit history; they need
not all have a rejected artifact row.

[`SqliteUnitOfWork`](../../workers/automation/src/jobctrl/infrastructure/materials/unit_of_work.py)
opens `BEGIN IMMEDIATE`; enrolled repositories defer commits and the outer
boundary commits or rolls back the whole flip. Materials, prior status changes
and the accepted
[provenance set](../../workers/automation/src/jobctrl/infrastructure/materials/bullet_provenance_repository.py)
are persisted together. Higher-generation provenance saves retain earlier rows;
same-generation saves replace that generation's rows. Events and best-effort
requirement-fit coverage enrichment occur after the flip, outside it.

The [production tailor factory](../../workers/automation/src/jobctrl/scoring/tailor.py)
shares the connection/unit of work across default materials, policy and
provenance repositories. Injecting other repositories does not automatically
inherit that atomicity guarantee. The aggregate cannot supply it on its own.
Rendering/file writes precede database persistence: rollback preserves registered
accepted materials but is not atomic filesystem rollback or a promise that
unregistered candidate files cannot remain. Explicit suppression is a separate
operation; it was not used by the probes.

`GenerateCoverLetterUseCase` loads current approved resume text and requires
an approved resume PDF. The completion marker is removed before storage.
Validation and fabrication checks use profile facts, with the target
role/company permitted as application context. Each attempt gets a unique text
path. A rejected refresh retains an existing approved cover letter and records
the rejected attempt in `cover_letter_attempts`. A successful refresh replaces
cover text and marks an old approved cover PDF superseded. Subsequent cover-PDF
rendering is separate: it does not supply the resume path's render-before-flip
guarantee for the cover text/PDF pair. Existing tests explicitly preserve that
distinction.

### Templates and export ownership

[`apps/api/src/resume-templates.ts`](../../apps/api/src/resume-templates.ts)
owns style-only template versions, pinned defaults and per-job overrides.
Effective selection prefers the job assignment, then profile default, then
built-in template. Metadata records template/version IDs, version number, name,
content hash and assignment source. Templates cannot be used to store
profile/job facts.

`ensureCurrentResumeTemplateMaterials` reuses accepted text, writes temporary
text/HTML/PDF files and awaits the renderer before persistence. It rereads the
next generation, source generation and effective template version/hash inside
a short transaction before promotion. Success registers a new approved
generation with `source: "resume_template_lazy_refresh"`, `base_generation`,
`base_resume_text_artifact_id` and `base_resume_pdf_artifact_id`. It preserves
older registered artifacts. This is render-only reuse, not another factual or
language review. The refresh writes layout boxes, not new canonical bullet
provenance. Consumers needing factual provenance must resolve the pinned base
relationship rather than assuming the new generation number owns it.

The fences inspected here compare generation and template metadata; they do
not establish an immutable byte fence against arbitrary in-place file mutation.
Cleanup after failures is best effort. These limits motivate the explicit byte
and provenance bindings in the future design.

[`resume-pdf-render.ts`](../../apps/api/src/resume-pdf-render.ts) normally calls
the long-lived JSON-RPC worker; its transport/result checks are covered by
[focused tests](../../apps/api/test/resume-pdf-render.test.ts).
Python's
[`HtmlResumePdfAdapter`](../../workers/automation/src/jobctrl/infrastructure/materials/html_resume_pdf.py)
builds structured HTML/CSS from permitted payload/profile data, writes HTML and
uses Playwright Chromium for a PDF with DOM-derived layout boxes.

The web
[`BrowserPdfExportAdapter`](../../apps/web/src/shared/adapters/local/BrowserPdfExportAdapter.ts)
has a different authority: the connected editor DOM passed to `downloadPdf`.
It awaits fonts, applies template geometry, rasterizes pages, adds a searchable
text layer, excludes editor chrome and restores temporary DOM attributes/styles
in `finally`. Its
[tests](../../apps/web/src/shared/adapters/local/BrowserPdfExportAdapter.test.ts)
inspect edited text, multi-page Letter geometry, detached-source rejection and
rasterization failure with injected PDF/rasterizer doubles. This can export
current unsaved editor state; it does not imply saved artifact acceptance.
Browser export, live HTTP/API/RPC dispatch and their equivalence with worker
PDFs were **not executed by this investigation's probes**.

<a id="synthetic-evidence"></a>

## Synthetic evidence

All profile/job/model inputs were finite repository-test-derived synthetic
fixtures. No real profile, account, messages, browser profile, provider service
or application submission was accessed. The controller-prepared project
interpreter was Python 3.12.13; the prepared Node interpreter was 22.21.1 with
pnpm 10.24.0. Python package observations were pytest 9.1.1, Playwright 1.58.0
and pypdf 6.19.0. The real Chromium launch reported 145.0.7632.6.

Artifact identifiers below are relative to the controller-retained evidence
bundle root, **not repository files or public download links**. Complete
original logs and receipts keep their original private machine locators in that
local bundle. The document includes no absolute machine paths.
`evidence-index.json` is the immutable measurement inventory, SHA-256
`8670815bba397e4e07ab907aca5843c2cc40ce2ee3fa16f73f617ac4a8c89645`.
It lists hashes for original probes, per-attempt source snapshots, raw streams,
receipts, inputs, synthetic databases/artifacts and copied broker baseline logs.
Later documentation/publication receipts are separate from that inventory.

### Executed worker measurements

`python_probe.py` normally imports the production domain/use cases, database
initializer, profile/materials/policy/provenance/analysis repositories, validator,
assembler and HTML/PDF renderer. `fixtures.py` copies finite fixtures and
scripted doubles from
[`test_tailor_provenance_integration.py`](../../workers/automation/tests/test_tailor_provenance_integration.py);
its source provenance is recorded in the manifest. Scripted provider responses,
synthetic analysis/fit input and recording event publication are injected. The
canonical analysis and achievement facts are saved through real repositories.
No live scoring, model judgment or provider quality is measured.

The materials, policy and provenance repositories share a real SQLite
connection/unit of work. The persistence fault calls the real provenance
repository's save, then raises before transaction exit. The profile-change seam
saves a changed canonical summary after a real render and before persistence.
The renderer-failure seam raises explicitly. Other successful resume renders
use the production adapter and real Chromium, without substituting PDF bytes.

The final completed run is `python-attempt-5`, exit 0. Snapshots
`python-accepted.json` through `python-cover-rejected.json`, the original
streams and `inspection.json` retain observed identities/rows/hashes.

| Scenario | Observed result |
| --- | --- |
| Accepted source | Generation 1 approved text/PDF, three provenance rows, one canonical achievement record. Experience source `acme_swe`, evidence `ev_latency`, requirement `req_latency`; provenance artifact ID equals the accepted text ID. |
| Invented 200% metric | `failed_validation`; current generation 1 artifact IDs, statuses, hashes, provenance and evidence rows unchanged. |
| Invented Chief Technology Officer in prose | `failed_validation`; title finding; the same preservation comparison passed. This is a prose-title probe, not a changed structured title field. |
| Malformed JSON response | `failed_validation`; unchanged accepted state. The finite response script subsequently supplied a judge-shaped non-resume response; this is not a claim that every attempt returned identical malformed bytes. |
| Provider exception | `provider_error`; unchanged accepted state. |
| Injected render failure | `error`; rejected attempt retained, prior registered text/PDF and provenance unchanged. |
| Injected failure after provenance writes | Exception propagated; actual transaction rollback preserved generation 1 and its three provenance rows. No replacement approval was committed. |
| Successful replacement control | Generation 7 approved with new text/PDF IDs and three new provenance rows; earlier registered bytes and earlier provenance retained. Only the latest failed generation is superseded by this factory path; the historical generation 1 rows remain inspectable. |
| Canonical summary changed during render | `TailoringPolicyChangedError`; generation 7 artifact IDs/bytes and six total provenance rows unchanged. The intentional profile save itself remains saved. |
| Cover-letter control, then invented 200% refresh | Control `ok`, refresh `failed_validation`; approved cover ID/bytes and resume/provenance unchanged. Rejected letter recorded in metadata history. |

The initial accepted text ID was `a15240ac21814acc8c94147bd47004d6`, SHA-256
`139e63a0dda1f315e698f5d8e4ba70c25494110e4146dce65fa14336dc87071a`.
The initial PDF ID was `d067ec83f23949309ec68957f6096616`, SHA-256
`77e381aaff0c045a1f71fc4102e61ddbe08f1754d8608aeec0c7063a4701ee7a`.
The successful replacement retained the same text hash but had a different PDF
hash. PDF hash equality across fresh renders is therefore not an acceptance
criterion; preservation compares the original registered files against their
own recorded hashes.

The read-only `inspect_evidence.py` measured one page in the initial real PDF.
Extracted text retained the synthetic name, company, official title, historical
date and 40% metric. This establishes those sample markers, not complete reading
order, visual fidelity, all-page clipping, font coverage or multilingual quality.
DOM layout-box persistence is observed metadata, not visual QA.

### Executed template measurements

`template_probe.mts` normally imports the template service and native
better-sqlite3 through the prepared Node toolchain. It uses the finite synthetic
schema/seed copied from
[`resume-templates.test.ts`](../../apps/api/test/resume-templates.test.ts);
that schema is a focused service fixture, not exact-schema admission testing.
The injected renderer writes synthetic PDF-labelled bytes containing the HTML.
Those bytes are not a real PDF/browser measurement.

The completed `template-attempt-2` returned exit 0. A compact profile-default
template resolved to its exact version. Refresh registered generation 2 with
the chosen template metadata, base generation 1 and the original text/PDF
artifact references. Original and refreshed text SHA-256 were both
`582057ad27f66e215b5e5f1e06c17cde4fefc1869a0579b734686a20ff975e4d`.
The generation 1 files remained unchanged.

Injected renderer failure returned `failed` and preserved all accepted rows
and file hashes. Changing the effective template inside the awaited renderer
returned `failed` with “The effective template changed while refreshing”.
Injecting a concurrent generation 3 in-progress row returned `failed` with
“Job materials changed while refreshing”. Generation 2 accepted artifacts
remained unchanged in both cases. This is deterministic race injection on the
same database, not a multi-process contention or live API measurement.
`template-original.json`, `template-accepted.json`,
`template-render-failure.json`, `template-template-race.json`,
`template-material-race.json` and `template-attempts.json` retain the rows.

### Every unsuccessful attempt

These are retained investigation failures, corrected without production source
changes. A successful rerun does not erase the original outputs or establish
that an earlier partial run completed.

| Attempt, exit | Actual failure and scope |
| --- | --- |
| `python-attempt-1`, 1 | Copied fixture header placed a future import after other text; import SyntaxError, no product measurement. Original source in `python-attempt-1-sources/`. |
| `python-attempt-2`, 1 | Default redirected browser cache lacked Chromium. Initial render returned error, assertion stopped; complete browser error and original rejected synthetic workspace retained. |
| `python-attempt-3`, 1 | Existing compatible browser cache selected; initial generation approved through real Chromium. Evidence query used nonexistent `profile_achievement_evidence`; corrected to the canonical table. |
| `python-attempt-4`, 1 | Resume preservation/control/fence assertions completed. Cover fixture used the wrong completion marker and exhausted its response script on retry. Corrected to the production completion-marker constant and a single bounded cover attempt. |
| `template-attempt-1`, 1 | tsx CLI IPC socket reported `EADDRINUSE` before service execution. Rerun used Node's direct tsx import loader, preserving the prepared interpreter/environment. |

Each named attempt has complete original `.stdout`, `.stderr` and
`.receipt.json` files plus a `-sources/` snapshot. Attempt 4's partial
measurement JSON is additionally retained in
`python-attempt-4-snapshots/`. Successful Python stderr still contains the
expected injected render-failure traceback and title rejection; it is retained
in full rather than removed from the receipt.

### Reproduction and integrity

The runner records command, UTC start/end, environment, exit status and a
180-second outer process deadline. Separate owned workspace names prevent
accidental reuse. Restore the source commit and controller-prepared locked
dependencies, verify the manifest, then supply the recorded Node/Corepack
environment and an available compatible Chromium cache. Private path bindings
belong in the local environment/receipts. Run from the checkout root with the
retained probe/fixture files together; use fresh synthetic directory names:

```sh
# PYTHON is the controller-prepared project .venv interpreter.
# NODE and COREPACK are its recorded absolute tool bindings.
# EVIDENCE is the retained bundle root. Set the recorded Node environment first.
# Run each command through run_evidence.py (180-second subprocess deadline).
"$PYTHON" "$EVIDENCE/run_evidence.py" replay-python   "$PYTHON" "$EVIDENCE/python_probe.py" replay-python-synthetic
"$PYTHON" "$EVIDENCE/run_evidence.py" replay-template   "$NODE" --import ./apps/api/node_modules/tsx/dist/loader.mjs   "$EVIDENCE/template_probe.mts" replay-template-synthetic
```

Rebind the runner's browser-cache locator for another machine before replay;
record its new hash and environment rather than claiming a byte-identical
launcher. Assertions compare generation/status, approved IDs, registered byte
hashes, canonical evidence/provenance and template/base bindings. Original
local receipts retain normally imported module locations; the manifest maps
repository-relative source identifiers to SHA-256.

| Artifact identifier | SHA-256 |
| --- | --- |
| `source-lock-manifest.json` | `c3d1d96e046b1cb6418c553e22fa0f95ea8e7675dab159df30d7c66b8effad15` |
| `python_probe.py` | `a9ad3f33bf467fde5a973bd34d74e1615de0c8fb2972fd659ca9d91c418248f9` |
| `fixtures.py` | `029cf7efb48b911e8d4e67f41eca6f97af2ae8e61743727944d4663d66ed649c` |
| `template_probe.mts` | `34db14be86f7bf5aa7b3090ec4a9c6472826f37cae475ce1fa74d2ce28e042e4` |
| `inspection.json` | `02d7bafe40e51e4bc8d62c90a5d5a468436f885a1d42a496333fb53c7a0b0497` |
| `python-attempt-5.stdout` | `5054fdb18db95ff4989a969e0ad14d8010849327d405c946d7bec75566a7bb72` |
| `python-attempt-5.stderr` | `78c8c62a3e670985c4df4ba80524f764abe5afdf27593d442b6441b87c5590e5` |
| `template-attempt-2.stdout` | `4b5e969f7a7e196d11dab0d139ae2b842646df05248e6ce154698d4f7ed098f7` |
| `worker-focused.junit.xml` | `2714a17cf3b727c9acd99e73358c018915769449241ffc139d23d08ca5b0fe03` |
| `template-regressions.junit.xml` | `c478240f719bb6742c987ac18024080a02994860dc04bfe3fbbc5402f590a93c` |

Actual lock hashes were rechecked before execution:

- `workers/automation/uv.lock`:
  `c7a3609dab6c93fdaa9f247ef88a943d74629457042ce64d7a92320092ba40d6`.
- `pnpm-lock.yaml`:
  `f58933349adc295cad3ff96ba14d5cae6a62b37fcb83d12fe94a72063aaa0b75`.

The role executed the four requested worker modules through the prepared
interpreter with JUnit: `test_materials_aggregate.py`,
`test_materials_use_cases.py`, `test_materials_repository.py` and
`test_tailor_provenance_integration.py`: **182 collected/executed, zero failures,
zero skips**. These include acceptance, generation history, provenance and
failed-refresh fixtures. The focused template/PDF-render Vitest files executed
**14 tests, zero failures, zero skips**, using the recorded Corepack environment.
Commands and complete streams are retained in `worker-focused.*` and
`template-regressions.*`.

This selection is not the full `checks.materials-role-selection` recipe with
its 341-test minimum. Copied broker baseline checks describe the original
candidate, not this document's edited checkpoint. Independent publication
receipts must remain separately attributable to their actual candidate.

<a id="future-architecture-not-implemented"></a>

## Future architecture — not implemented

Introduce a separate reviewed locale-variant identity in Materials, without
mutating the accepted source or promoting translated text into canonical Profile
facts. Each variant belongs to one tenant/job/material kind and one immutable
source binding. A UI language preference must not silently choose either
material locale. Require explicit source locale and target locale, using
validated language tags and recording whether the source tag was declared or
confirmed. Unknown or mixed source language needs clarification rather than
automatic acceptance.

### Immutable source and target bindings

The following explanatory types are **not implemented contracts**:

```ts
type LocaleVariantBinding = {
  tenantId: string;
  jobId: string;
  materialKind: "resume" | "cover_letter";
  source: {
    materialsGeneration: number;
    textArtifactId: string;
    textBytesSha256: string;
    sourceAcceptanceSha256: string;
    pdfArtifactId: string | null;
    pdfBytesSha256: string | null;
    sourceLocale: string;
    profileId: string;
    profileVersion: number;
    relevantFactsSha256: string;
    provenanceGeneration: number;
    provenanceArtifactId: string;
    provenanceSnapshotSha256: string;
  };
  targetLocale: string;
  terminologyRevision: number;
  terminologySha256: string;
  targetRevision: number;
  targetTextSha256: string;
  templateVersionId: string;
  templateHash: string;
  renderedArtifactSha256: string;
  translatorVersion: string;
  reviewPolicyVersion: string;
};
type VariantAcceptance = {
  bindingSha256: string;
  languageReviewDecisionId: string;
  factualReviewDecisionId: string;
  acceptedBy: string;
  acceptedAt: string;
};
```

A profile version alone cannot reconstruct historical facts. Retain immutable
relevant fact/evidence excerpts, ownership, original text and provenance
snapshots alongside their digests. If the source is a render-only refresh,
resolve and validate its explicit base-generation/artifact lineage to the
factual generation; do not manufacture new provenance. Reject missing, cyclic,
cross-tenant or inconsistent lineage. Cover-letter fact bindings need their own
source claim/evidence snapshots; resume bullet provenance cannot substitute for
cover-letter support.

Pin raw approved source bytes before spending on translation; reread hashes
and source acceptance identity before promotion. Keep semantic fact hashes
distinct from raw artifact hashes. Template changes create a new rendering
revision, not a silent update to reviewed bytes. Every target edit increments
revision and invalidates decisions that bound different text/render hashes.

### Protected facts and terminology uncertainty

Historical names, employer/institution names, official job titles, dates,
achievements, metrics, attribution and scope remain authoritative. Do not
localize a title into a higher rank, translate a proper name into a different
entity, shift a date, convert a rounded metric into an exact one or turn team
work into individual ownership. Retain the official source title/name verbatim;
a reviewer-approved explanatory gloss can appear separately. Locale-dependent
date/number presentation must preserve exact source values, units and precision,
with source references available to review. A glossary can guide presentation
but cannot authorize additional facts.

Translate the accepted document's claims, not all latent profile achievements.
Every target segment maps to source segments and relevant fact/evidence IDs,
including headings/positioning where factual. Omission of a source claim is
visible to reviewers and cannot silently erase pinned content. Reordering needs
explicit segment identity; a line number alone is insufficient. The source and
target review view should show original wording, proposed wording, protected
tokens, fact references and unresolved terminology.

For example, translating “owned backend service” must preserve the recorded
scope, not imply formal department leadership. Ambiguous terms should carry
alternatives and a review decision rather than a model confidence assertion:

```json
{
  "sourceSegmentId": "experience:synthetic-role:claim-1",
  "sourceTerm": "service owner",
  "proposedTargetTerm": "responsable del servicio",
  "alternatives": ["persona a cargo del servicio"],
  "uncertainty": "May imply formal managerial authority in the target context.",
  "status": "needs_independent_review",
  "factReferences": ["synthetic-achievement-1"],
  "decisionId": null
}
```

Terminology revision, glossary entries, reviewer rationale and any unresolved
uncertainty must be inspectable. Unresolved factual ambiguity blocks acceptance;
language preference disputes require an explicit reviewer resolution or rejection.
Back-translation and automated multilingual checks may assist review, but neither
proves equivalence or resolves responsibility/seniority ambiguity by itself.

### Independent review and exact acceptance

Use two recorded review dimensions: language/register/terminology quality and
factual/source fidelity. Reviewers must be independent of the generator;
automated self-scoring cannot satisfy either human decision. The factual reviewer
checks canonical excerpts, historical protected facts, omitted claims and every
target/source mapping. The language reviewer checks idiom, regional meaning,
professional register and uncertainty decisions in the explicit target locale.
The acceptance policy should require two distinct reviewer identities for those
decisions and disclose their roles. Translator/editor authors cannot approve
their own output. A final accepting user may also be a reviewer, but acceptance
still requires both independent decisions bound to the final bytes.

Generation creates `draft` output, never an approved locale variant. Review
decisions pin source binding, target revision, terminology revision, template
binding and rendered bytes. Only explicit acceptance of that exact final variant
sets its accepted identity. Any text, terminology or render change requires new
applicable review. Existing source approval must not be copied as translated
approval. Review and acceptance events contain safe IDs/digests/status, with
private translated text retained at its material owner.

### Refresh, stale sources and cancellation

Keep accepted source and accepted target variants visible while generation,
review or rendering is pending. Use separate attempt identity and an
expected-current-acceptance fence. Render the proposed target before a short
transaction atomically writes the variant, source mappings, decisions and
accepted pointer. Failed generation, validation, review, rendering or persistence
retains the previous accepted target and its byte hashes; failed drafts remain
inspectable history.

A newer source generation, relevant fact change or changed source byte hash
makes the target stale for current use without rewriting its historical binding.
A byte-identical source re-render is still a different artifact/acceptance
binding; explicit rebind and applicable review are required, never inferred
language approval. Template-only changes likewise need rendering review before
updating the accepted rendered variant. Unrelated application preferences can
leave the relevant fact digest unchanged.

Rejected or late output never replaces the accepted pointer. Cancellation
invalidates the attempt's promotion token; a late provider/render response may
be retained as cancelled history but cannot be accepted. A newer request,
review edit or source change wins over stale completion. Bound provider timeouts
and file cleanup separately; orphan files must not be mistaken for registered
accepted artifacts. Retain history according to the owning material retention
policy rather than deleting prior accepted output during refresh.

Submission approval remains a separate Apply boundary. Language/factual review
authorizes a material variant, not submitting an application. The selected
variant ID, source/target revisions and actual artifact hashes must enter the
future submission approval fingerprint. Unsaved editor export must either remain
an explicitly unreviewed download or go through a new revision/review/acceptance
path before it can be used as approved submission material.

### Required proof before production implementation

Future implementation needs locale-aware factual validation and independent
language evaluation; the current English-oriented token/judge checks cannot
establish cross-language equivalence. Build synthetic corpora for names,
official titles, historical dates, achievement ownership, units, negation,
regional terminology, omissions and ambiguous seniority. Include mixed-language
sources and glossary changes, with expected blocking/review outcomes.

Prove source/target/reviewer identity fences through delayed output, cancellation,
concurrent edits, failed persistence and stale-source refreshes. Exercise actual
API/RPC and editor acceptance using owned synthetic workspaces. Verify language
metadata on HTML/PDF, font/glyph coverage, Unicode/diacritics, text expansion,
line wrapping, A4/Letter pagination, RTL/bidirectional ordering, accessible reading
order and searchable text. Independently inspect every measured page and compare
worker rendering with browser export of the final accepted editor revision.
Those multilingual, typography, RTL and export-equivalence measurements were
not performed here; the one-page Chromium sample and injected template renderer
cannot stand in for them.
