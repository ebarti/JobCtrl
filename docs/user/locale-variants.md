# Reviewed locale variants

Open a job's **Artifacts** section and choose an accepted resume or cover letter,
its source locale, and a different target locale. Supported locales are English
(`en`), Spanish (`es`), French (`fr`), German (`de`), Italian (`it`), Portuguese
(`pt`) and Catalan (`ca`). Selection is explicit; JobCtrl does not infer a locale
or promise support for another language.

**Generate locale variant** translates descriptive wording from the selected
accepted material and the saved canonical facts. It retains the original. Names,
historical titles, employers, institutions, credential designations, dates and
achievement values must remain literal. A translation does not establish that a
credential is equivalent to a credential in another jurisdiction.

Compare the original and translated lines. Review terminology and original
credential designations, then review formatting separately. Both confirmations
and passing independent model reviews are required for **Accept translation**.
Missing terms, unsupported language and factual uncertainty block acceptance.
An ambiguous credential remains visible in its original designation; acknowledging
its warning cannot create equivalence. You can reject a candidate without
changing the original or another accepted locale.

Acceptance creates text, escaped HTML, Chromium PDF and DOCX from the same
translated lines and validates their ordered claims before saving acceptance.
Downloads appear only for accepted variants. A render, export, persistence or
version conflict leaves previously accepted material and locale history intact.
If an export file is missing or its hash differs, download fails; the accepted
record is retained for inspection. Refresh the history after a version conflict.

History records each source artifact and generation, byte hash, selected locales,
canonical fact snapshot/version, translator/provider/model and schema/prompt
versions. It also records independent terminology, formatting and acceptance
choices. Unchanged generation inputs reuse recorded model authority. Decisions
are terminal for that exact source binding; a changed source/profile binding
creates another variant. Older workspaces without locale history start empty;
they do not acquire invented translations, provenance or acceptance.

The offline demo exposes locale generation as unavailable. Translation uses the
configured tailoring model and spend lane and sends the selected source material
and canonical facts to that provider. It never submits an application.

## CLI

Use the canonical job ID and the exact revision returned by `list`:

```sh
jobctrl locale-variants JOB_ID
jobctrl locale-variants JOB_ID --operation generate --artifact-id ARTIFACT_ID \
  --source-locale en --target-locale es --expected-revision 0
jobctrl locale-variants JOB_ID --operation review --variant-id VARIANT_ID \
  --expected-revision 1 --terminology confirmed --formatting confirmed --decision accepted
jobctrl locale-variants JOB_ID --operation export --variant-id VARIANT_ID \
  --format docx --output translated.docx
```

Commands return JSON. Export requires a new destination file and refuses to
replace an existing file. Use `--decision rejected` to retain a rejected review.
API and RPC contracts are documented in [Jobs & Materials](../api/jobs-and-materials.md).
