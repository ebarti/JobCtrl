# Material Locale Variants

Materials owns a separate `material-locale-v1` contract on the native schema-14
artifact registry. The domain owner is
`domain/materials/locale_variants.py`; the persistence/orchestration owner is
`infrastructure/materials/locale_variants.py`. The existing accepted Materials
aggregate, Profile schema and application approval contract remain independent.

## Authority And Identity

Requests explicitly select an approved `tailored_resume` or `cover_letter`, a
source/target language pair, expected source generation and profile version.
The source snapshot records its artifact ID, generation, SHA-256 and exact text;
canonical facts are retained by recorded IDs alongside their generation-time
text. Historical names, titles, institutions, credentials, dates and achievement
values have literal structural protection. Prose meaning never comes from a
lexicon, overlap, regex classifier or a fallback translation.

Two strict determinations own translation and independent verification:
`material_locale_translation` and `material_locale_verification`, schema `1`,
with `material-locale-translation-v1` and `material-locale-verification-v1`
prompts. The native determination owner binds tailoring lane/spend preflight,
provider/model, fingerprint, exact line/source citations and immutable results.
Its locks/cache reuse unchanged requests. The verifier controls acceptance;
code validates inventories, citations, immutable fields and literal numbers.
Missing terminology, unsupported languages and ambiguous credentials are explicit
findings. Unsupported capabilities have no model authority and cannot be accepted.

Readers join recorded determination IDs. Absent/mismatched authority is reported
as unavailable while the historical source and locale content stay inspectable.
Acceptance and export additionally validate persisted semantic entity bindings,
source versions, exact final text and passing authority.

## Native Persistence And Failure Boundaries

Each immutable text revision has a `job_artifacts` row with `stage = locale`,
`artifact_type = locale_revision`, and versioned JSON metadata. Terminology and
formatting decisions append independently with revision ID/content hash and UTC
timestamp. Acceptance/rejection history and registered export references append
under expected-version checks. Rejected whole revisions cannot subsequently be
accepted. Accepted content cannot be edited through review mutations.

SQLite writer transactions fence source bytes, source status/generation,
canonical profile version/facts and locale revision immediately before publishing.
Unique, owned output files are flushed before their references commit. Failed
publication removes only newly staged files and rolls back the locale row; it
never truncates a source file, accepted locale revision or prior export. Semantic
attempt state is separate from acceptance. Old schema-14 registries need no
physical migration and legacy artifact rows receive no invented locale metadata.

TXT and escaped HTML derive directly from the accepted text. Standard-library
DOCX packaging preserves paragraph order/Unicode and is parsed after staging.
The existing Playwright PDF renderer receives that same escaped HTML; actual PDF
text is extracted and checked for claim-preserving order/content before publishing.
New exports are registered as `locale_txt`, `locale_html`, `locale_pdf` and
`locale_docx`. The existing artifact-open port opens their registered IDs.
The API projection owner reconciles registry identities even without a new
pipeline event, so CLI-created exports remain discoverable.

## Product Boundaries

`material_locale_variants` is a registered synchronous worker JSON-RPC owner.
The HTTP owner validates strict Contracts requests/results and canonical Job IDs,
binds the exact worker app directory/database and resolves tenant/job ownership.
CLI commands use the same worker owner. The generated endpoint client exposes
`materialLocaleVariants`; new model-backed demo operations are unavailable.

The Job Detail view composes the Materials-owned panel. Its tenant-first query
key, mutations, retained accepted content, failure rollback and targeted
invalidation live in Materials. Browser/local artifact opening stays behind ports.
History periodically refreshes to observe mutations from other local clients;
source-material events invalidate the locale read cache.

Owning regressions are `test_locale_variants.py`,
`test_locale_variants_integration.py`, API `locale-variants.test.ts`, colocated
component/accessibility tests and stories, and browser `locale-variants.spec.ts`.
Browser route fixtures prove browser/client wiring; they do not substitute for
native Python RPC/model-port or actual renderer verification.
