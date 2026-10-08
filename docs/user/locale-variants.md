# Reviewed Locale Variants

Create a translated resume or cover letter from the current accepted material in
**Job Detail → Artifacts → Reviewed locale variants** or **Apply Review**.
Select the material and enter explicit source and target locale tags, such as
`en` and `es`. Generation uses the configured Materials model in the tailoring
spend lane. The original stays available.

Descriptions may be translated. Historical names, titles, dates, institutions,
credential names and achievement values retain their original wording and
values. A translation is a separate reviewed document; it does not update your
Profile or replace the resume/letter selected for Apply.

Inspect the translated preview, the original, source-line mappings and recorded
model authority. Missing terminology and ambiguous credentials remain visible
with their original wording. JobCtrl does not assert credential equivalence.
Unsupported source or target languages produce an explicit refusal. Provider,
budget or structural failures show an error and preserve accepted history.

Accept **terminology** and **formatting** separately. Both human decisions apply
to the exact candidate revision. A failed semantic review cannot be overridden.
Once both are accepted, export **Text**, **HTML**, **PDF** or **DOCX**. All formats
come from the same accepted document and exports record its revision and hash.
PDF export checks extracted content and refuses a mismatch or unreadable glyphs.
Existing exports remain available if a later export or generation fails.

Source or Profile changes block new review and export until you generate a fresh
variant. The previous accepted locale history remains inspectable. Older source
artifacts without recorded semantic or accepted-byte bindings are explicitly
unavailable; regenerate and accept the original material first. An unavailable
binding is never reconstructed by comparing prose.

If recorded locale authority is unavailable, Job Detail shows an explicit error
and keeps the original materials available. Reload before attempting a review.

The offline demo reports locale operations unavailable.

## CLI

Inspect the state to obtain its revision. Generate an explicit candidate, then
inspect again before each independent review or export:

```sh
jobctrl locale-variants inspect JOB_ID
jobctrl locale-variants generate JOB_ID resume en es --expected-revision 0 --request-id REQUEST_UUID
jobctrl locale-variants review JOB_ID VARIANT_ID terminology accepted --expected-revision 1 --expected-variant-revision 1
jobctrl locale-variants review JOB_ID VARIANT_ID formatting accepted --expected-revision 2 --expected-variant-revision 2
jobctrl locale-variants export JOB_ID VARIANT_ID docx --expected-revision 3 --expected-variant-revision 3
```

Use `cover_letter` instead of `resume` for letters. Export formats are `text`,
`html`, `pdf` and `docx`. Request UUIDs make retrying an identical generation
idempotent; reusing one with different locale/material choices is rejected.
Unchanged source inputs reuse recorded model authority. A fresh candidate still
requires its own two human decisions.

See the [API contract](../api/complete-contract.md#material-locale-variants) and
[architecture](../architecture/material-locale-variants.md) for binding and
failure details.
