# Material locale variants

Materials owns reviewed locale translations in
`domain/materials/locale_variants.py`; its SQLite/file adapter is
`infrastructure/materials/locale_variants.py`. The feature consumes registered,
approved resume/letter source bytes and canonical profile sources. It never
replaces the source artifact or invokes Apply.

Source and target locales come from the bounded `en/es/fr/de/it/pt/ca` catalog.
A content-addressed binding records tenant-scoped job/artifact identity, source
generation, SHA-256, source metadata hash and recorded approved lifecycle state,
profile version/hash, canonical fact snapshots and ordered original line IDs.
Artifact creation time is recorded as creation time, not invented approval time.
Each candidate has a locale revision and immutable original/translated source joins.
Historical typed fields and numerical literals are representation invariants;
meaning is decided exclusively by source-bound model determinations.

Four independent, strict determinations use the existing tailoring lane and
spend preflight: translation, translation terminology/formatting review, claim
verification and quality review of the actual final lines. Their complete
envelopes persist in existing determination tables with IDs, input fingerprints,
provider/model, citations and schema/prompt versions. Equal inputs reuse authority
without new calls. Readers validate stored IDs against the durable envelopes;
they do not join by similar text. Missing terms, unsupported language and factual
uncertainty block acceptance. An ambiguous credential can retain its original
literal designation with a visible warning, never an asserted equivalence.

The versioned `__jobctrl_locale_variants_v1` namespace lives in each existing
`job_materials.metadata_json` generation. No DDL or exact-v14 change is required.
Revision comparisons sum namespace revisions across the job's generations.
Publication uses `BEGIN IMMEDIATE`, compares that revision, and checks the exact
source/profile binding again. Preflight checks the same fences before each new
model call. Same-generation aggregate saves preserve the persisted namespace
atomically in their UPSERT, including unrelated companion Materials metadata.
Namespace absence is empty history, never inferred provenance or acceptance.

User terminology, formatting and acceptance/rejection decisions are separately
recorded and terminal. Acceptance stages all four exports in a new private
directory beneath the workspace. Text, escaped HTML and OOXML DOCX use the same
ordered lines. Real Chromium renders HTML to PDF. Structural validation compares
text, HTML paragraphs, DOCX XML and ordered PDF glyphs (ignoring only layout
whitespace), then records each export hash and document/line identities. A failed
stage or fenced commit removes only its new staging directory. Prior accepted
history, source artifacts and exports remain untouched. Download checks containment
and hashes and requires explicit acceptance; it does not regenerate files.

`material_locale_variants` is a synchronous workspace-fenced RPC command. Shared
endpoint schemas dispatch the HTTP operations; the download owner adds safe
attachment headers. The CLI calls the same adapter. Job Detail composes the public
Materials component; query/mutation ownership stays in Materials hooks. Locale
keys are descendants of tenant/job detail so existing source-material and profile
invalidation handlers refresh them. Review mutations optimistically disable
acceptance, restore cached state on failure, and invalidate only the locale key.

Focused regressions live in `test_locale_variants.py`,
`test_locale_variants_integration.py`, API `locale-variants.test.ts` and the
component's unit/accessibility tests. Browser interaction coverage is in
`locale-variants.spec.ts`; its structural route doubles are separate from the
real HTTP-to-Python integration case. Completion evidence belongs to the run's
retained evidence directory, not product documentation or historical plans.
