# Material Locale Variants

Locale variants are a distinct Materials contract, implemented by
`domain/materials/locale_variants.py` and
`infrastructure/materials/locale_variants.py`. They do not replace source
artifacts or modify Apply decisions. The [user workflow](../user/locale-variants.md)
contains UI and CLI instructions.

Each variant snapshots its tenant/job, accepted source artifact ID/type/generation,
accepted byte hash and verification ID, recorded approved source state and source
creation timestamp, explicit locales, canonical Profile JSON,
Profile version/hash, source-line mapping and independent locale generation and
revision. Source writers record `accepted_text_sha256`; legacy missing bindings
remain unavailable. Render-only template refreshes retain existing semantic IDs
and anchors only when the text bytes are identical. Reviewed edits record their
own accepted byte hash and existing semantic authority.

The model owns translation, language support and terminology equivalence. Code
checks complete ordered line inventories, verbatim citations, canonical literal
fields, original numeric literals and revision fences. Independent terminology,
claim-verification and quality determinations follow translation. Missing terms
and ambiguous credentials keep their cited original wording. Unsupported locales
produce a stored refusal. There is no lexical judgment or fallback.

Determinations use the existing repository and tailoring spend lane. They record
provider/model, schema/prompt versions, fingerprints, citations and verdicts.
Their semantic entity identity derives from immutable inputs independently of
candidate IDs, allowing unchanged inputs to reuse recorded authority without new
model calls. Each candidate retains its own two human review decisions. Readers
join recorded determination IDs and reject foreign/mismatched authority. Human
acceptance and export also rejoin these IDs and compare the exact reviewed lines.
Job Detail reports unavailable locale authority explicitly while keeping its
original material readers available.

Exact-v14 `job_materials.metadata_json.locale_variants_v1` stores a versioned
namespace with its revision, immutable variant snapshots, append-only human
reviews, accepted-document bindings, registered exports and safe failure entries.
No physical migration or new dependency is required. Reads combine histories
across source generations. An aggregate Cover/PDF save retains this namespace;
locale writes reload and merge current metadata, preserving unrelated/companion
fields. The implementation does not depend on an unmerged screening-answer
branch.

Source, Profile and locale revisions are checked before spending and again at
commit. Each new model call also runs the spend preflight. Human reviews fence
both the job's locale revision and the candidate revision. Both terminology and
formatting acceptance are required, and failed semantic gates cannot be
accepted. Accepted documents retain their revision and content hash.

Exports are staged with unique IDs below `tailored_resumes/locale_variants` and
registered only after content validation and a second fence. Text, HTML, PDF and
DOCX use one immutable line-mapped document. HTML reuses the current letter
scaffold and CSS and validates exact ordered content; PDF reuses the current
Playwright renderer and validates
ordered extracted text. DOCX uses standard-library ZIP/XML and verifies ordered
paragraphs. Export failure removes only its new staging file and records a safe
failure. Source bytes and accepted locale documents/exports remain intact.
Downloads require a recorded export ID, accepted revision/document binding,
contained real path and registered byte hash.

The synchronous `material_locale_variants` RPC is runtime-bound to the API's exact
workspace/database and dispatches the same strict operations as the CLI.
Additive HTTP contracts live in `packages/contracts`; the generated endpoint
client inherits the mutation. GET state, Job Detail and export reads make no model
calls. The Web component reads through Operations Job Detail, with Materials-owned
optimistic mutations, rollback and revision/source-aware response reconciliation.
The Session port supplies generation request identifiers. Profile/source events
already invalidate Job Detail; locale mutation settlement also invalidates Apply
Review. Offline demo mutations are unavailable.
