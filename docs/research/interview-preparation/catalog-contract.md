# Versioned interview catalog

The 21 authored Markdown documents in this directory are the original public
research packet for [issue #993](https://github.com/ebarti/JobCtrl/issues/993).
Their recorded review date is 1 October 2026. They contain public source
paraphrases and synthetic examples. The original research wording remains
intact, including its description of proposed rehearsal and unvalidated numeric
anchors; that wording is research history, not a product capability claim.

The first integration revision is `2026-10-01.1`, with schema version `1`.
Explicit authored metadata in `catalog-metadata.v1.json` assigns each active card
its role lenses, responsibility and competency tags, acceptable answer formats,
default format, attribution kind, card revision and rubric revision. Consumers
must use these fields; titles, prefixes and topic names are not runtime rules
for assigning a role or requiring STAR. An unknown target role or interview
stage remains `unknown` until the user or canonical job context establishes it.

## Compile and validate

From the repository root:

```sh
python3 docs/research/interview-preparation/compile_catalog.py --check
```

The standard-library compiler reads only the authored Markdown and sidecar.
It validates source-byte hashes, metadata, stable IDs, revisions, source/author
membership, worked examples and editorial relationships. It compares the exact
deterministic bytes with the single runtime authority:
`workers/automation/src/jobctrl/assets/interview/catalog.v1.json`.
Running without `--check` writes that asset after the same validation.

The imported inventory is 121 active questions, 15 topics, 57 source records,
20 author groups, 363 draft dimensions, 17 worked-example families and 31
editorial relationships. Counts describe this revision; they are not quality
scores or mandatory preparation quotas. C08 is reserved-retired and cannot be
recycled. B11 and TS09 default to principle answers. C07 persistently seeks the
employer's budgeted range first, while leaving the final choice to the candidate.

## Digests and retained history

`catalogDigest` is SHA-256 of the complete catalog object with that field omitted,
serialized as sorted-key, compact UTF-8 JSON without ASCII escaping. Card digests
use the same convention with `cardDigest` omitted; rubric digests cover the
rubric array. The asset adds one trailing newline. Its raw-byte SHA-256 is
therefore a separate value, used to compare installed Python and TypeScript.

The sidecar seals the published catalog digest and all original Markdown hashes.
Compilation requires a present, lowercase 64-character hexadecimal digest seal
that matches the complete catalog; omitting or changing it cannot unseal v1.
Do not overwrite v1 or reinterpret a historical revision after publication.
Content changes require a new catalog revision and retained asset, with an
explicit loader/revision registry update. Historical preparation additionally
retains the exact selected card/rubric revisions and digests, card snapshots,
profile evidence excerpts, relevant job/employer inputs and generation metadata.
Changes to current inputs produce stale diagnostics; they do not rewrite those
generation-time snapshots. Legacy prep remains unbound rather than receiving
invented card associations.

## Installed readers

Python loads `catalog.v1.json` through
`importlib.resources.files('jobctrl').joinpath('assets', 'interview', ...)`.
`load_interview_catalog()` validates the asset and returns a detached snapshot;
`load_interview_catalog_bytes()` and `catalog_raw_digest()` expose exact bytes
and their digest. `get_interview_question()` distinguishes unknown and retired
IDs. `validate_interview_selection()` preserves order and rejects empty,
unknown, retired, duplicate, over-budget or stale-bound selections before model
use. Question IDs contain an uppercase prefix and two digits, with a maximum of
12 characters checked by wire validation, the compiler and Python selection.
A preparation request selects at most 16 questions.

The request can additionally supply `evidenceSelections` per question, fenced
by the required positive `evidenceProfileVersion`. Each entry preserves up to
eight canonical accepted-fact IDs of at most 200 characters in the user's order.
Evidence IDs retain their exact canonical string identity and case; validation
rejects blank-only IDs without trimming or normalizing them. They do not use the
question ID format. An explicit empty entry
means no personal evidence was selected and produces gaps; only an omitted
entry permits deterministic evidence selection. Question snapshots retain
`evidenceSelectionMode` and `selectedEvidenceIds` separately from question
selection. The worker checks current tenant/profile ownership, accepted-fact
membership and the profile version before provider spend. Notes and new
recollections cannot satisfy accepted-fact membership. A changed profile returns
`evidence_profile_changed`; invalid choices return `invalid_evidence_selection`.

The wheel and source distribution include the resource explicitly. The installed
TypeScript API must load the same resource at
`JOBCTRL_PAYLOAD_DIR/worker/site-packages/jobctrl/assets/interview/catalog.v1.json`.
The production API is an ESM bundle, so installed loading cannot rely on a
source-relative URL. A missing installed asset is an error; docs, a prototype,
plugin files, a provider and SQLite are not catalog fallbacks.

Pure shared vocabulary lives in `packages/domain-types/src/interview/`;
`packages/contracts/src/interview.ts` owns wire validation and re-exports that
vocabulary. Existing prep kinds remain readable alongside `question_outline`.
Optional generation context and question metadata distinguish legacy data from
question-driven preparation. Generated statements, hypothetical reasoning,
unverified recollections and accepted profile facts remain distinct.

Notes are independently revisioned, with `expectedRevision` compare-and-swap,
a 20,000-character text limit and retained source bindings. User saves cannot
self-assign `supported` or inherit a passed generation audit. The
`InterviewQuestionNoteSaved` event contains only job/question IDs, revision,
source generation and update time; it contains no note or answer text.

## Content maturity

Attribution and reading coverage are included in the asset, including selected
passages, author overviews and unread-book limits. Direct interview guidance,
practice extrapolation and editorial synthesis are separate categories. Full
source-ledger tensions, the content-review limits for staff and executive roles,
acceptable alternatives and question-specific probes remain inspectable.

Draft weak/strong dimensions explain preparation expectations. They do not
establish validated assessment, coaching efficacy, readiness, a hiring
probability or a composite leadership score. [Independent calibration](evaluation.md#calibration-before-product-use)
is still required before grading is offered as reliable. Rehearsal, transcripts,
microphone capture and live interview assistance are separate future scopes.
