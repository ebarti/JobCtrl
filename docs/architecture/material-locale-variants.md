# Resume Locale Variants

Resumes owns the retained locale capability in the Python target. This contract
is being migrated and has not yet been established by integrated product-path
verification. The source is an accepted resume and its exact revision, not a
free-floating copy of Profile or a newly invented fact.

## Authority and Identity

A request identifies the accepted source artifact/revision, source and target
locales and relevant canonical fact references. Translation and semantic
verification use source-bound model determinations with lane/spend preflight,
strict response validation, citations and persisted provenance. Historical
names, employers, dates, credentials, titles and values remain anchored to the
source. Ambiguous credentials, terminology or unsupported languages must remain
explicit; lexical heuristics cannot decide meaning or authorize a translation.

## Persistence and Failure Boundaries

Review decisions and acceptance are bound to the exact locale revision, its
source version and content. Publication rechecks these bindings and rejects a
stale or unapproved revision. Edits and reviews cannot silently rewrite an
accepted revision. Failed translation, review, rendering, export or storage
preserves the source, prior accepted locale versions and existing export bytes.

Supported TXT, HTML, PDF and DOCX outputs must derive from the same accepted
locale snapshot and be accessed through owned artifact metadata. Exact route,
storage and rendering details remain implementation-dependent until verified.
See [materials](materials.md) and [API contract](../api/complete-contract.md#material-locale-variants).
