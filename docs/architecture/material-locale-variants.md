# Reviewed material locale variants

Design investigation for [issue #1039](https://github.com/ebarti/JobCtrl/issues/1039).
This page proposes reviewed translations of accepted resume and cover-letter
materials. It adds no translator, locale variant, language-quality guarantee,
export-equivalence guarantee, or production behavior. Existing tailoring,
review and rendering provide useful bindings, but none is a translation contract.

The investigation pins source revision
`0b61aef78b03d6d198e34c561c69ae0eec921969`. The existing
[Materials Audit](materials.md), [Tailoring Contract](tailoring.md) and
[semantic-determination decision](../decisions.md#_2026-10-07-semantic-judgments-are-llm-determinations)
remain the owners of current behavior. The proposal below is a separate future
capability; it does not change those contracts.

<a id="current-implementation"></a>

## Current implementation

### Accepted materials and historical reads

[MaterialsSet][aggregate] is identified by tenant, job and positive generation,
with one artifact slot per type: tailored resume, cover letter, resume PDF and
cover-letter PDF. Artifact identity is separate from generation. The aggregate
checks slot types and text-before-PDF dependencies. Resume acceptance combines
structural validation and the independent quality verdict; a review-required
candidate is not approved. The aggregate is a lifecycle carrier, not an LLM
reviewer: `with_resume_attempt` can accept a missing verdict, and
`with_cover_letter` receives a validation result. The use cases supply the
stronger model gates. A stored `approved` status is not proof of translation
review or owner approval to submit an application.

[SqliteMaterialsRepository][repository] distinguishes two reads.
`load` returns the maximum generation, including a rejected refresh.
`load_current_approved` selects the newest generation with an approved tailored
resume. Cover/PDF use cases use the latter. A failed refresh can therefore make
the latest generation newer without changing the accepted one.

[TailorResumeUseCase][use-cases] loads versioned profile input, employer
analysis, job interpretation and, where configured, the requirement-fit ledger.
It validates generator IDs and claim locations, assembles the final text,
verifies its claims against allowed sources, and obtains an independent quality
judgment. High-fit resumes have an additional six-persona model determination.
The accepted text, artifact metadata, line anchors and applicable determination
references belong together. Generator mappings are proposals; verifier-affirmed
source contributions authorize provenance and served-requirement coverage.
A low diagnostic quality score is not a rejection rule; the typed verdict is
the authority.

A successful replacement PDF is rendered before superseding the previous
approved generation. The generation flip and provenance persistence use
[SqliteUnitOfWork][unit-of-work]: an outer `BEGIN IMMEDIATE`, one commit, rollback
on failure, and enrolled repositories that defer their own commit. The
repository additionally uses a savepoint and collision-resistant lineage token
to reject an independently allocated conflicting generation. Policy/profile
fences in `SqliteTailoringPolicyRepository.assert_generation_current` re-read
canonical inputs inside the active unit of work. These are local transaction
and identity protections, not a general distributed-file transaction guarantee.

### Canonical facts, generation fingerprints and recorded joins

[profile_sources][sources] supplies a minimized inventory keyed by source ID:
personal fields, the executive baseline, confirmed achievement evidence,
experience title/company/date/location/summary and authored bullets, education,
and skills. Achievement evidence enters only when `user_confirmed` is true.
Its source includes authored text, scope, action, tools, metrics and outcome.
A raw experience bullet is a different source from a confirmed achievement
card. Neither unconfirmed recollections nor an unrelated fact may supply a
confirmed achievement by implication.

The [profile policy helper][profile] forcibly sets `allow_title_reframing` to
false; [the tailoring plan][policy] sets `preserve_titles=True`. The validator
rejects a changed historical title. This is stronger than merely asking a
generator to preserve titles. It does not make all rendered fields byte-identical
to Profile: the [assembler][services] and [resume document builder][document]
apply punctuation and date formatting, and perform configured source selection.

[determine][determinations] fingerprints the kind, schema/prompt versions,
schema, provider/model, lane, tenant/entity identity, canonical source text and
context. It locks the request identity, validates a cached envelope and its
citations, or binds the lane and runs spend preflight before a new model call.
Code validates source membership, verbatim quotes and exact values; it does not
decide the meaning of prose. A fingerprint identifies a particular determination
request, not the stored artifact's raw byte hash. A model verdict, a profile
snapshot fingerprint and an export hash are different authorities.

[SqliteDeterminationRepository and save_artifact_anchors][determination-storage]
persist envelopes, entity bindings and artifact line anchors. The material writer
joins recorded determination IDs and requires passing review for approved
artifacts. Accepted resume metadata carries `claim_verification_id`,
`quality_determination_id`, applicable `resume_adversarial_id`, policy
fingerprints, and source/requirement line mappings. The PDF receives accepted
source metadata; deferred PDF rendering records `source_artifact_id` and
`source_generation`. These IDs support an audit trail. They do not certify a
target-language translation, PDF extraction, or export equivalence.

### Cover refresh, saved review and export behavior

`GenerateCoverLetterUseCase` requires an approved resume and resume PDF. It
reads the resume file and passes `resume_text` to its attempt helper, but the
actual model request is built from canonical profile sources, the posting,
writing style, sign-off and feedback; it does not include that resume text.
This distinction matters: a prerequisite and a read do not establish a
source-text derivation. Claim support and quality are separate model calls.
Failed validation stores an attempt in material metadata while retaining an
existing accepted cover letter. Accepted cover replacement gives the text a
new artifact ID and supersedes the old cover PDF. It does not reuse that PDF
as if its bytes represented the new letter.

`RenderPdfUseCase` re-renders absent or non-approved PDFs. For a resume, it
checks that supplied payload/Profile assembly equals the accepted text before
calling the renderer. Cover rendering reads accepted cover bytes. It records
source artifact and generation with the returned PDF. Rendering exceptions are
logged; if nothing was rendered, the outcome is `noop` with an empty error.
Thus `noop` alone is not evidence of successful export. The native probe
observed this behavior for a failing cover renderer.

[Resume review drafts][review] bind a base generation, text/PDF artifact IDs,
renderer format and an independently revisioned edited text. The
[saved-edit reviewer][edit-review] reads current canonical profile/analysis
sources, runs claim and quality determinations, and returns revision/text
fingerprint, profile version, analysis generation and determination IDs.
The API checks those bindings, renders outside the database transaction, then
rechecks revision, material generation, profile and analysis before promoting
attempt-specific files and persisting artifacts. Source revisions and human
edits do not inherit a translation review because they share a draft or job.

[Resume templates][templates] are versioned style/layout data, not stored
profile facts or translations. Resolution is per-job pinned override, pinned
profile default, then built-in template. Staleness compares template version
and content hash. Render-only refresh reads accepted text, writes temporary
text/HTML/PDF, awaits rendering, and rechecks generation, source generation and
effective template in a short transaction before promotion. Failed/racing
refreshes preserve prior material. A successful refresh creates a new approved
generation with `base_generation`, `base_resume_text_artifact_id` and
`base_resume_pdf_artifact_id`; it does not copy semantic anchors/determination
bindings to the new artifacts. The probe found original artifacts still
approved and their original anchors intact. Readers must distinguish this
lineage from fresh claim review.

[HTML resume rendering][html] builds a semantic document and escaped markup;
its Python wrapper has no locale parameter or HTML language attribute.
The API template-refresh wrapper declares `lang="en"`. Neither surface has an
explicit source/target locale contract. [The PDF adapter][html] invokes
[Playwright rendering][playwright] and records layout boxes; [API PDF RPC][pdf-rpc]
awaits the worker dispatcher and validates the renderer response. Inspected
contracts and fake-renderer tests do not establish live-browser pagination,
glyph support, accessible reading order or target-language quality.

<a id="synthetic-evidence"></a>

## Synthetic evidence

### Provenance and reproduction

All measured facts and jobs were synthetic. The owned probes used normal imports
of current production modules, exact-v14 SQLite creation and disposable isolated
data, with explicit schema-aware fake providers and fake PDF renderers.
The fake providers choose verdicts independently of wording; there is no
translator, semantic word-list classifier, labeled corpus, evaluation baseline,
or recorded-output replay queue.

The retained evidence namespace `author-evidence/` is relative to the
controller-allocated authoring artifact root, outside the source diff. It is
an artifact identifier, not a repository path or public download link.
Original private logs and receipts retain exact argv, environment, UTC clocks,
exit status and machine locators. The controller owns their custody. The public
identifiers and hashes here permit integrity checks without publishing those
locators. The controller handoff was read in full and hash-checked; its baseline
checks and dependency preparation refer to the original candidate, not this
edited document.

The original candidate ID was
`9701b5e8e26e02dc4ee37e8cc78c5be10ca9f464c6b2fd3f4ec2486061de64b4`;
its recorded content hash was
`a4afd97df899880f4908ac301b6780d8e70090957cfd027846203cd96781eed0`.
The source manifest pins imported source, relevant tests, check configuration
and lockfiles. Python probes used the controller-prepared project virtual
environment (CPython 3.12.13). Locked worker tests used uv 0.12.17.
Node probes/API tests used the recorded Node v22.21.1, Corepack environment and
prepared native SQLite binding, without dependency installation by this role.

To reproduce, resolve the relative artifacts in that owned evidence namespace,
verify hashes, and run the retained executable version using its receipt's
interpreter, checkout and environment against disposable data. Python imports
are supplied through the recorded worker source/test paths. The successful
Node probe uses the installed tsx import loader through the pinned Node
interpreter, avoiding the CLI IPC runner. Receipts contain the exact executable
paths; the public page deliberately carries only relative identifiers.

### Observed outcomes

| Native measurement | Observed result |
| --- | --- |
| Identical profile, sources and draft; opposite support verdict | `pass` produced `approved`; `fail` produced `failed_validation`. Quality was not called after failed resume support. |
| Independent quality verdict on identical draft/facts | `pass` with score 0.01 approved; `fail` with score 0.99 returned `failed_judge`. |
| Accepted first resume | Generation 1; six anchor rows. Actual artifact/determination IDs, source snapshot fingerprint and byte hashes are in original output. These six rows are a measurement, not a universal line-count contract. |
| Fifteen failed resume refresh scenarios | All retained the accepted generation, resume/PDF IDs, bytes, anchor rows and accepted artifact bindings. Some failures added rejected history, so latest and current-approved differed. |
| Identical-input re-tailor | Only `GeneratedResumeDraft` was called again; interpretation, support and quality determinations were reused. Three envelopes remained. New artifact IDs/generation did not imply new semantic review. |
| Direct unchanged determination request | One call and one `interview`-lane preflight; the second call returned the same envelope without call/preflight. |
| Budget-denied re-tailor | `budget_denied`; preflight observed `enrichment` lane before job interpretation and zero model calls. This is the actual first blocked call, not proof that it reached tailoring spend. |
| Confirmed source changed from 3 to 4 units | Snapshot fingerprint and claim determination ID changed; generation, claim verification and quality calls ran again, while interpretation was reused. Unconfirmed card stayed outside `profile_sources`. |
| Historical title change with requested permission | `failed_validation`, with literal title-rewriting-disabled error. Rendering retained the source title when asked for a promoted/translated title. |
| Native text/document/HTML | Synthetic accented names survived; source `R&D — Engineer` rendered as `R&D, Engineer`, and `2020–2024` as `2020-2024`. Punctuation preservation is not raw-byte equality to Profile. Python HTML had no language attribute. |
| Deferred resume PDF with unbound payload | `error` / `pdf_source_binding_invalid`; no render; accepted text artifact stayed current. |
| Rejected cover refresh | Accepted cover bytes/ID, resume/PDF, prior cover PDF and recorded bindings remained intact. |
| Accepted cover refresh | New cover ID; old PDF became `superseded`. Failing PDF refresh preserved that state and returned `noop`/empty error; subsequent successful fake render replaced only the cover PDF and bound the new cover ID/generation. |
| Native template refresh | Profile default resolved, job override took precedence, generation 2 completed; text bytes identical, fake PDF bytes different, original rows still approved. New artifacts had base lineage but no new anchor rows. |
| Repeated template read | `not_required`; zero further fake renderer calls. |
| Template renderer failure / assignment race during await | Both returned `failed` and preserved prior rows/bytes. Race message explicitly required retry after effective-template change. |

The fifteen resume failures were generation/verifier/quality provider errors,
provider unavailable, malformed JSON, strict schema error, foreign generator
evidence, failed support, failed quality, foreign verifier citation, non-verbatim
quote, mismatched exact value, budget denial, PDF renderer failure and staged
persistence failure. Their actual codes are respectively `provider_error`
(three stages), `provider_unavailable`, `malformed_json`,
`schema_violation`, `failed_validation`, `failed_validation`,
`failed_judge`, `foreign_source_id`, `non_verbatim_quote`,
`mismatched_value`, `budget_denied`, render `error`, and the injected
`RuntimeError`. The persistence injection raised after staging generation 2
inside the enrolled unit of work; its rollback preserved generation 1.
This is not a power-loss or disk-full trial.

The unchanged template-refresh text hash was
`49f4c5b0d515b3901758e8219ed3a5af0c357564b07453a21e15aee7fa75c685`
for both generations. The initial synthetic profile serialization hash was
`ef746332f5e09c8ff7f20bc77fdc7c9a4ad4e458b80877bc9801f088b4a74232`;
its tailoring snapshot fingerprint was
`sha256:645b6b38a16e88e1c76cf36f5acc0ad6b7c7f6841c66e3cfbde148c44df3a91c`.
These hashes identify exact synthetic representations, not real profile facts.

### Original attempts and locked regression receipts

Two Python probe failures were harness errors: attempt 01 ordered by a nonexistent
`source_id` column, and attempt 02 compared the complete binding history
against the accepted binding subset. Rejected-generation bindings legitimately
extend history. Attempt 03 corrected the query/comparison and passed all
preservation assertions. Both failed originals, full traces and executable
versions remain retained; they are not product failures.

Both tsx CLI attempts failed with `EADDRINUSE` on the runner IPC pipe before
executing the probe. Attempt 03 used the pinned Node import loader and passed.
The second script version also takes an explicit checkout argument so package
manager working-directory changes cannot select the wrong import root.

The following locked regressions executed successfully, without skipped cases:

- Worker: `test_materials_aggregate.py`, `test_materials_use_cases.py`,
  `test_materials_repository.py`, `test_tailor_provenance_integration.py`,
  `test_artifact_determinations.py`, `test_semantic_determinations.py`:
  **144 executed, 144 passed, 0 skipped, 0 failures/errors**.
- API: `test/resume-templates.test.ts` (11), `test/resume-review-drafts.test.ts`
  (16), `test/resume-pdf-render.test.ts` (3):
  **30 executed, 30 passed, 0 skipped, 0 failures/errors**.

The worker command was `uv --project workers/automation run --locked --all-extras
pytest -q`, followed by those six full worker test paths and an owned
`--junitxml` destination. The API command was `corepack pnpm --filter
@jobctrl/api exec vitest run`, followed by the three paths, `--reporter=junit`
and an owned `--outputFile` destination. Retained receipts carry exact arguments.
The older provenance test's introductory prose still mentions a deterministic
never-fabricate detector; current code, explicit model fakes and measured verdicts
govern this investigation.

#### Evidence integrity

Each identifier below is relative to `author-evidence/`. Hashes are SHA-256 of
the original retained file, including full original logs where applicable.

| Relative artifact identifier | SHA-256 |
| --- | --- |
| `investigation-index.json` | `104982482acd655e226bdc2133513e69ada96cf15f21a643152dc560d002899d` |
| `sources.json` | `f7c894f4172c543f9a3ec3112ff2f20a2274776ceeb564b78e1c4bbc2810e6cf` |
| `imported-modules.json` | `07280b3b1f93201791a06b96d51bf4417f166441f1e440b9c9fe32bd795361b7` |
| `handoff-inspection.json` | `09a508c215940d8d1dac2f1b1bbcfb6aaa775210ebc25595ce6a7d46f89854d8` |
| `probe-inputs.json` | `bbb08b4f333d6da190610f405b01929e0e63e7a8ef3f9e2d273bde99f893506b` |
| `source-inputs.json` | `10d49a9b985cb0dc0b482a17a494b0b348de2142aa25f876592f7aba071ebe2f` |
| `render-inputs.json` | `ae7e258a149fdef9a5f6b0b4c0248d3ae6ef32d12ca3bb32750529696b81f863` |
| `render-text.txt` | `52e6f6353f1d3a1f488a88e29968bb6069a0a295d755fa3def0dea4e2bd73be2` |
| `render-document.json` | `302ca8550f7de868cbbd856223f997e1ae2e6758cc6b82e31764388f007414c1` |
| `render-html.html` | `16b4f8419f777688b53d6fc1c5c6e02900368dcf499c8884a3709335774dc5aa` |
| `worker-tests-01.junit.xml` | `10b59d16ccee910331f54ba29e2240186dc85197bf8852be2b0046b79663adc1` |
| `api-tests-01.junit.xml` | `e66c253a294e2dc06fb17d55bf138d955348ec81de7f55b23cadc5562ead6536` |
| `worker-tests-01.stdout` | `2ebb5e9280d7619ade72aa971625a00d55b7c38679e1ca72430b20a91a0bb94c` |
| `worker-tests-01.stderr` | `917dcb5fcdb0464dab7323ca3eda78fa126ee6ad28b504da495711ff2578967a` |
| `api-tests-01.stdout` | `57eaf6c690f717e28e8ef8822a740a115723f51b696443ae760a87baa9fbda72` |
| `api-tests-01.stderr` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `native-probe-01.stdout` | `2337fd8e26b85c985fcf15a5939e4ebdd0f5a5037e2e4995561e52165f04f521` |
| `native-probe-01.stderr` | `cefdfe5c1fade3430c9f3b5704cd487320b023f18b6fc1266aacee5b0e5b5f6f` |
| `native-probe-02.stdout` | `476f78703d862b0d7df65372a1e57258f4690567011210c7498b1f524343652e` |
| `native-probe-02.stderr` | `eb94eeb4f416c5afbc955fc8aeafb526438e15c173e885cdaea6ef7740040b26` |
| `native-probe-03.stdout` | `2e5193e394c852d75bf7a211ee1df4abaabfbb04a4777eab33d099a95a443ef2` |
| `native-probe-03.stderr` | `c452d04f2af54d3cb1b08f8b464d1d7df3af3f815a7c432875f01358f20733cc` |
| `template-probe-01.stdout` | `0779628a226640ac6afd42d7a093dad554c18f6e39b1193928c1d467ea9f406f` |
| `template-probe-01.stderr` | `2c2ff776c28a7e3af86777dde90632baa2f5b03f26627e535d8cfa3b0cf32c43` |
| `template-probe-02.stdout` | `ab2275b2223020693c96d49cf1032300521bc07439eb170cc83f04fd52c4f1f9` |
| `template-probe-02.stderr` | `385c1a4495c6aff6b8e4a333b388a4cab5192f64a666b3e9700776eb659f7035` |
| `template-probe-03.stdout` | `00087e1374c86b533192df0ce72b4be84d26bcda6b0095e970f6b9a30b6e9f1f` |
| `template-probe-03.stderr` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `source-probe-01.stdout` | `3239190cde7bd2d7be99a634cc2b79884f11d2d2ada0a3a20053120dd4ab716f` |
| `source-probe-01.stderr` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

Every attempt's `<attempt>.receipt.json` also appears, with its own hash, in
the investigation index. It records its frozen executable identifier/hash and
full stdout/stderr hashes. The imported-module manifest verifies normal module
locations and source bytes privately. The index includes source inputs,
render text/document/HTML outputs, disposable synthetic artifacts and original
executable snapshots. No logs, databases or probes enter the public source diff.

The source manifest includes the following pinned owners and locks (plus the
other imported worker/API modules and tests):

| Repository source/lock identifier | SHA-256 |
| --- | --- |
| `workers/automation/src/jobctrl/domain/materials/aggregate.py` | `b41510a9ac01db437abdb42c0bfd0b692f9ac3f6602aeeb98355fdef26aa805e` |
| `workers/automation/src/jobctrl/domain/materials/use_cases.py` | `a68f9486d4fa1f811a2a71137db823d2d5e931f75f424cc7c039debfe1e6a48b` |
| `workers/automation/src/jobctrl/domain/profile/canonical_sources.py` | `4799f7841762306e0a5528da481505d176d88d2252e1a69dfe10f0a2c634f0e4` |
| `workers/automation/src/jobctrl/infrastructure/materials/sqlite_repository.py` | `10f122c8d3a38012751cb01ebefddc1be8d2dadf94277e1cb5b59b4bfb6928f6` |
| `workers/automation/src/jobctrl/infrastructure/materials/unit_of_work.py` | `f60c0616913ea84953e4af00deeae14f398f8447bf648f128ffa21be19eba757` |
| `workers/automation/src/jobctrl/infrastructure/materials/html_resume_pdf.py` | `5766f0f83e7ad69aa53a92a11d1a1ae7df697298ae965c151e5c5c5cab465a1e` |
| `apps/api/src/resume-templates.ts` | `03eb7123167cd59e21a3cb8d246cd038c399589243ef293f09ee7944042c9e5a` |
| `apps/api/src/resume-review-drafts.ts` | `0f663a2dec9d5c3f383dbb4b1da947e74a198ec570b88dfdaa0e11f6f51a1163` |
| `apps/api/src/resume-pdf-render.ts` | `3076cb37f3de8d19256ea0592d546dc464e56618f4a852af479a64230f2efacd` |
| `scripts/checks.toml` | `cbe4620f5a1c92ee723b8edaae74af3b2a0f07c97d8698d9cf514352548915fa` |
| `workers/automation/uv.lock` | `c7a3609dab6c93fdaa9f247ef88a943d74629457042ce64d7a92320092ba40d6` |
| `pnpm-lock.yaml` | `f58933349adc295cad3ff96ba14d5cae6a62b37fcb83d12fe94a72063aaa0b75` |

### Measurement limits

Explicit fake verdicts establish model authority, structural binding, call/cache
behavior and failure preservation. They cannot measure translation accuracy,
naturalness, dialect suitability, independent reviewer competence or linguistic
equivalence. A fake PDF is a byte-bearing test artifact, not a usable PDF or
evidence of glyph/layout fidelity. Cover and template probes use production
functions, but the synthetic persistence injection is same-connection rollback,
not a multi-process crash test. Worker profile/policy commit fences were
inspected; these probes supplied snapshots and did not simulate a concurrent
canonical profile repository edit. The template-assignment race was a controlled
write during the awaited fake render.

No live provider, account, actual profile, browser UI, running API server,
application/submission, external employer surface, real Chromium rendering or
PDF extraction was executed here. Focused API tests cover draft/template service
and RPC contracts, not a live worker child. The separately opt-in dense-pagination
trial was not executed. This evidence is an investigation checkpoint, not a
claim that future locale production behavior or publication gates have passed.

<a id="future-architecture-not-implemented"></a>

## Future architecture (not implemented)

### A separate reviewed variant, with explicit locales

A future Materials-owned locale variant should be a separate immutable revision
stream, never a replacement for the accepted source artifact's slot or Profile.
The owner explicitly chooses source and target BCP 47 locale tags, including
regional conventions where relevant. Missing/unknown source language requires
owner resolution before generation. Neither job location, profile preference,
template name nor language detection may silently choose authority.
Mixed-language spans retain their declared locale and original protected terms.

Only an eligible accepted source artifact may start a variant. Capture tenant/job,
material type, source generation, artifact ID, exact source bytes/hash, source
line/field inventory, profile/fact snapshots, source review/determination IDs
and relevant analysis generation/requirements. Bind a PDF only as a distinct
source export, not by assuming its extracted text equals the accepted text.
Legacy artifacts missing an auditable line/fact inventory require an explicit
binding review before translation; do not reconstruct semantic anchors by
similarity or carry approvals from a render-only generation automatically.

Illustrative future types, not current API schemas:

```ts
type Sha256 = string;
type LocaleTag = string; // Validated BCP 47; explicitly owner-selected.
type LocaleVariantRevision = {
  variantId: string;
  revisionId: string;
  expectedParentRevisionId: string | null;
  tenantId: string;
  jobId: string;
  artifactKind: "resume" | "cover_letter";
  sourceLocale: LocaleTag;
  targetLocale: LocaleTag;
  source: {
    artifactId: string;
    generation: number;
    bytesSha256: Sha256;
    sourceInventorySha256: Sha256;
    profileId: string;
    profileVersion: number;
    factSnapshotSha256: Sha256;
    analysisGeneration: number | null;
    claimDeterminationId: string;
    qualityDeterminationId: string;
    renderLineage: Array<{
      artifactId: string;
      generation: number;
      bytesSha256: Sha256;
    }>;
  };
  targetBytesSha256: Sha256;
  mappingRevisionId: string;
  terminologyRevisionId: string;
  translatorDeterminationId: string;
  independentReviewIds: string[];
  ownerAcceptanceId: string | null;
  state:
    | "draft"
    | "terminology_blocked"
    | "review_required"
    | "reviewed"
    | "accepted"
    | "stale"
    | "superseded";
};
```

IDs resolve registered owners; hashes bind content, not authorization. A
`LocaleTag` string alone is not validated locale input. The schema must reject
unknown fields, foreign IDs, invalid locale tags, cross-tenant/job bindings,
duplicate line IDs and inconsistent source inventories before paid calls.

### Revisioned mappings and historical-fact preservation

Each target line should bind one or more exact source line/field IDs, original
spans and fact IDs, plus the declared translation/reordering transformation.
Summary splitting, merging and locale-specific order need explicit mappings;
do not require one-to-one line counts. Mapping completeness must cover headings,
skills, narrative, contact fields, dates and omissions as well as achievement
bullets. Legitimately omitted source text requires an explicit owner decision,
not an unrecorded shortening operation.

Keep historical personal/employer/institution/product names, official job titles,
employment/education dates, achievement attribution, quantities, units, currency
and scope as protected source values. Preserve the original title visibly;
an explanatory translated gloss is separate, clearly identified and reviewed,
never a promotion or replacement historical title. Avoid translating branded
product names into generic qualifications. Never change “contributed” into
“led,” a team achievement into an individual claim, an interval into longer
tenure, or a numeric result into a different value. Those examples describe
review obligations, not phrases for a lexical classifier.

Store original authored protected values and their source identifiers, even when
the accepted source renderer normalized punctuation. Distinguish raw Profile
value, accepted displayed value and target display. Localized month labels or
number punctuation may be an explicit reversible presentation mapping; dates,
quantities, units/currency and achievement ownership cannot change. No currency
conversion or new credential equivalence is part of translation.

```ts
type LocaleLineMapping = {
  mappingId: string;
  mappingRevisionId: string;
  targetLineId: string;
  targetTextSha256: Sha256;
  sourceSpans: Array<{
    sourceLineId: string;
    sourceFieldId: string | null;
    quote: string;
    spanSha256: Sha256;
    factIds: string[];
  }>;
  transform: "translate" | "reorder" | "split" | "merge" | "preserve";
  protectedValues: Array<{
    factId: string;
    originalValue: string;
    acceptedDisplay: string;
    targetDisplay: string;
    presentationRuleId: string | null;
  }>;
  terminologyDecisionIds: string[];
};
```

The model determines semantic faithfulness and contribution/attribution meaning.
Code enforces inventory membership, verbatim quotes, exact protected values and
authorized presentation mappings. Recorded IDs drive all later display joins.
Missing source records remain unavailable; token overlap, regexes and hand-tuned
prose thresholds never repair provenance or determine equivalence.

### Terminology uncertainty and independent review

A translator should return terminology uncertainties as first-class records:
source span/locale, target candidates, confidence/uncertainty rationale, affected
line IDs, domain context and any ambiguity about official titles, qualifications,
acronyms or technical terminology. Distinguish owner glossary preference from
source-backed factual authority. An uncertain credential equivalence must remain
unresolved, not become an invented local qualification.

Each resolution is revisioned and cites the decision maker, chosen wording,
rationale and affected mappings. It can preserve the original term with an
explanatory gloss. Unresolved consequential terminology blocks acceptance.
Owner resolution of wording does not independently certify source faithfulness;
changing the glossary or target wording invalidates affected review.

An independent reviewer should read exact source and target bytes, the protected
fact inventory, declared locales, mappings and terminology decisions, rather
than the translator's pass label alone. Record a separate review determination
for faithfulness/omission/unsupported additions and separate target-language
quality review. A different call/context must not inherit the translator verdict;
record provider/model, role, prompt/schema, input fingerprint and citations.
Where qualified human review is needed, record explicit human findings and
identity separately. “Reviewed” describes a recorded process, not a universal
language-quality guarantee.

Only after independent review passes and consequential uncertainty is resolved
may the owner accept that exact revision and byte hash. Acceptance must not
change canonical facts, original material, tailoring policy, fit, application
approval or submission state. The source original remains visible and usable.
Target variant selection for an application requires a separately bound owner
choice through the owning application workflow.

### Export verification is a separate binding

Rendering an accepted target revision should produce a separately registered
export with target revision/hash, source binding, template/version/hash,
declared locale and writing direction, renderer/font configuration and output
byte hash. Template precedence may follow the current explicit assignment
model, but a variant must record the effective pinned version. Locale-aware
labels, hyphenation and direction need a future rendering contract; the present
hardcoded/default wrappers do not supply one.

```ts
type LocaleExportVerification = {
  exportId: string;
  variantRevisionId: string;
  targetBytesSha256: Sha256;
  templateVersionId: string;
  templateSha256: Sha256;
  rendererVersion: string;
  fontInventorySha256: Sha256;
  locale: LocaleTag;
  direction: "ltr" | "rtl";
  outputBytesSha256: Sha256;
  extractionReceiptId: string | null;
  visualReviewReceiptId: string | null;
  status: "unverified" | "verified" | "failed";
};
```

A future verification must check extraction order, missing/duplicated text,
protected facts, glyph/font coverage, clipping, page breaks, links and accessible
reading order against the accepted target. PDF binary equality is neither
necessary nor sufficient for text/layout equivalence. Text equality in the
template probe established only text preservation. Keep translation review and
export verification independently labeled; neither can stand in for the other.
Changing only a template may preserve translation review when target bytes and
all semantic bindings are unchanged, but requires fresh export verification.
Changing target text, mappings or terminology requires fresh semantic review.

### Failure, refresh and concurrency fences

Each generation, review, terminology resolution and export attempt should have
its own ID, safe failure code, source/input hashes, clocks and provenance.
Lane binding and spend preflight precede every new model call. Reuse only a
validated determination with identical identity/content context; a new locale,
model, prompt, source revision, terminology resolution or reviewer context
changes that identity. Provider, spend, schema, citation and persistence
failures remain distinct, with no lexical fallback.

Resolve inputs before spending; render before the short publishing transaction.
At commit, compare expected variant revision, accepted source artifact ID and
generation, source/target bytes, fact/profile snapshot, relevant analysis,
mapping/terminology revisions, review IDs and template/export bindings.
Reject late responses after any concurrent change. A profile or analysis update
may leave an old variant inspectable with its historical snapshot, while
marking it stale for current use; it must not silently rewrite history or
inherit fresh approval. A new accepted source material requires a new translation
revision and independent review. A render-only source generation needs an
explicit, hash-checked lineage resolution, not an automatic approval transfer.

Use attempt-specific temporary files and a revision comparison inside the owning
transaction. Losing attempts clean only their own temporary/unregistered files.
Failed refreshes, reviewer disagreement, uncertainty, budget denial,
cancellation, rendering errors and commit conflicts preserve the last accepted
variant and its verified export. Record failure separately and keep candidate
text inspectable without presenting it as accepted. Unlike the current standalone
PDF `noop` behavior, the future export attempt should report a distinct failed
status when rendering was attempted and failed.

Before production implementation, require synthetic model-authority and source
binding tests, failed-refresh and race measurements, independent scoped review,
and real target-locale export inspection. Include supported script/direction/font
cases and unavailable/unknown language states. No benchmark corpus or recorded
semantic-output replay is needed to prove these structural invariants.
Live language quality and export QA remain separate work from this investigation.

[aggregate]: https://github.com/ebarti/JobCtrl/blob/0b61aef78b03d6d198e34c561c69ae0eec921969/workers/automation/src/jobctrl/domain/materials/aggregate.py
[repository]: https://github.com/ebarti/JobCtrl/blob/0b61aef78b03d6d198e34c561c69ae0eec921969/workers/automation/src/jobctrl/infrastructure/materials/sqlite_repository.py
[use-cases]: https://github.com/ebarti/JobCtrl/blob/0b61aef78b03d6d198e34c561c69ae0eec921969/workers/automation/src/jobctrl/domain/materials/use_cases.py
[unit-of-work]: https://github.com/ebarti/JobCtrl/blob/0b61aef78b03d6d198e34c561c69ae0eec921969/workers/automation/src/jobctrl/infrastructure/materials/unit_of_work.py
[sources]: https://github.com/ebarti/JobCtrl/blob/0b61aef78b03d6d198e34c561c69ae0eec921969/workers/automation/src/jobctrl/domain/profile/canonical_sources.py
[profile]: https://github.com/ebarti/JobCtrl/blob/0b61aef78b03d6d198e34c561c69ae0eec921969/workers/automation/src/jobctrl/resume_profile.py
[policy]: https://github.com/ebarti/JobCtrl/blob/0b61aef78b03d6d198e34c561c69ae0eec921969/workers/automation/src/jobctrl/domain/materials/policy.py
[services]: https://github.com/ebarti/JobCtrl/blob/0b61aef78b03d6d198e34c561c69ae0eec921969/workers/automation/src/jobctrl/domain/materials/services.py
[document]: https://github.com/ebarti/JobCtrl/blob/0b61aef78b03d6d198e34c561c69ae0eec921969/workers/automation/src/jobctrl/domain/materials/resume_document.py
[determinations]: https://github.com/ebarti/JobCtrl/blob/0b61aef78b03d6d198e34c561c69ae0eec921969/workers/automation/src/jobctrl/domain/determinations.py
[determination-storage]: https://github.com/ebarti/JobCtrl/blob/0b61aef78b03d6d198e34c561c69ae0eec921969/workers/automation/src/jobctrl/infrastructure/determinations.py
[review]: https://github.com/ebarti/JobCtrl/blob/0b61aef78b03d6d198e34c561c69ae0eec921969/apps/api/src/resume-review-drafts.ts
[edit-review]: https://github.com/ebarti/JobCtrl/blob/0b61aef78b03d6d198e34c561c69ae0eec921969/workers/automation/src/jobctrl/infrastructure/materials/user_edit_review.py
[templates]: https://github.com/ebarti/JobCtrl/blob/0b61aef78b03d6d198e34c561c69ae0eec921969/apps/api/src/resume-templates.ts
[html]: https://github.com/ebarti/JobCtrl/blob/0b61aef78b03d6d198e34c561c69ae0eec921969/workers/automation/src/jobctrl/infrastructure/materials/html_resume_pdf.py
[playwright]: https://github.com/ebarti/JobCtrl/blob/0b61aef78b03d6d198e34c561c69ae0eec921969/workers/automation/src/jobctrl/infrastructure/materials/playwright_html_pdf.py
[pdf-rpc]: https://github.com/ebarti/JobCtrl/blob/0b61aef78b03d6d198e34c561c69ae0eec921969/apps/api/src/resume-pdf-render.ts

The inspected regression owners are [test_materials_aggregate.py](https://github.com/ebarti/JobCtrl/blob/0b61aef78b03d6d198e34c561c69ae0eec921969/workers/automation/tests/test_materials_aggregate.py); [test_materials_use_cases.py](https://github.com/ebarti/JobCtrl/blob/0b61aef78b03d6d198e34c561c69ae0eec921969/workers/automation/tests/test_materials_use_cases.py); [test_materials_repository.py](https://github.com/ebarti/JobCtrl/blob/0b61aef78b03d6d198e34c561c69ae0eec921969/workers/automation/tests/test_materials_repository.py); [test_tailor_provenance_integration.py](https://github.com/ebarti/JobCtrl/blob/0b61aef78b03d6d198e34c561c69ae0eec921969/workers/automation/tests/test_tailor_provenance_integration.py); [test_artifact_determinations.py](https://github.com/ebarti/JobCtrl/blob/0b61aef78b03d6d198e34c561c69ae0eec921969/workers/automation/tests/test_artifact_determinations.py); [test_semantic_determinations.py](https://github.com/ebarti/JobCtrl/blob/0b61aef78b03d6d198e34c561c69ae0eec921969/workers/automation/tests/test_semantic_determinations.py); [resume-templates.test.ts](https://github.com/ebarti/JobCtrl/blob/0b61aef78b03d6d198e34c561c69ae0eec921969/apps/api/test/resume-templates.test.ts); [resume-review-drafts.test.ts](https://github.com/ebarti/JobCtrl/blob/0b61aef78b03d6d198e34c561c69ae0eec921969/apps/api/test/resume-review-drafts.test.ts); [resume-pdf-render.test.ts](https://github.com/ebarti/JobCtrl/blob/0b61aef78b03d6d198e34c561c69ae0eec921969/apps/api/test/resume-pdf-render.test.ts).
