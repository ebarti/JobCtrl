---
description: "Generate source-linked resume and cover-letter translations, review terminology and formatting separately, and export an accepted locale snapshot."
---

# Reviewed Locale Variants

Open **Job Detail → Locale variants** after a resume or cover letter has been
accepted. Select the accepted source, its source language and the target language,
then choose **Generate locale variant**. Supported language codes are `en`, `es`,
`fr`, `de`, `it`, `pt` and `ca`. Region-specific codes and other languages are
explicitly unsupported; the API and CLI retain an unsupported-language finding
rather than guessing a translation.

Translation changes descriptions while keeping historical names, titles,
institutions, credentials, dates, locations and achievement values literally
unchanged. It never claims that a credential is equivalent to a credential in
another country. The original artifact remains intact.

A separate source-bound model verifies each translated line against the accepted
source and canonical profile facts. **Recorded verification sources** shows the
original quotation, canonical facts, verifier reason, determination IDs, model,
prompt/schema versions and source hash. Missing terms and ambiguous credentials
remain visible and block acceptance. A missing recorded authority also blocks
acceptance and export; historical content remains inspectable.

Review **terminology** and **formatting** independently. Both decisions bind to
this exact revision and content hash. Only a passing verification, no unresolved
findings and two approving reviews enable **Accept locale revision**. Rejecting
the whole revision is terminal. Locale acceptance does not approve an application
or replace the original accepted material.

Accepted revisions offer **TXT**, **HTML**, **PDF** and **DOCX** exports from one
localized text snapshot. The PDF uses the existing Chromium renderer and must
preserve the actual extracted text; rendering or unsupported glyph failures do
not publish an export. Review the displayed content and rendered formatting before
using a translated document. Prior accepted revisions and registered export files
remain available when generation, review, persistence or export fails.

Source bytes, source generation, profile facts/version and the expected locale
revision are checked again before a mutation commits. A stale source or revision
requires reloading the current history and generating from current accepted inputs.
The API cannot silently promote an older translation to the new source generation.

## CLI

Use a canonical Job ID and the source artifact ID shown in the history:

```sh
jobctrl material-locale JOB_ID
jobctrl material-locale JOB_ID --operation generate \
  --source-artifact-id SOURCE_ID --source-locale en --target-locale es \
  --generation 1 --profile-version 1
jobctrl material-locale JOB_ID --operation review --revision-id REVISION_ID \
  --expected-version 1 --dimension terminology --decision accepted --note 'Terminology reviewed'
jobctrl material-locale JOB_ID --operation review --revision-id REVISION_ID \
  --expected-version 2 --dimension formatting --decision accepted --note 'Formatting reviewed'
jobctrl material-locale JOB_ID --operation accept --revision-id REVISION_ID --expected-version 3
jobctrl material-locale JOB_ID --operation export --revision-id REVISION_ID --expected-version 4 --format docx
```

Each successful mutation returns updated history and increments the revision's
version; always use that returned version for the next command. Generation uses
the configured tailoring model and spend policy. Unavailable providers and budget
denials have no offline semantic fallback. The public demo marks this local
workflow unavailable.

See the [API contract](../api/complete-contract.md#material-locale-variants) and
[architecture](../architecture/material-locale-variants.md).
