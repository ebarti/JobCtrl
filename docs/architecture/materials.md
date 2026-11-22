# Materials and Auditability

The accepted transformation assigns resume documents and exports to Resumes,
profile facts and approved wording to Profile, qualification and wording
coverage to Fit, and requirement meanings to Requirements. Implementation and
integrated parity are in progress. See [tailoring](tailoring.md) for the
composition contract and [locale variants](material-locale-variants.md) for
translation and export authority.

## Canonical Employer Analysis

Employer analysis and optional company research are source-bound inputs, not
candidate facts. Their owning feature must preserve the source, version,
identity, uncertainty and decision provenance supplied to downstream consumers.
A missing or failed refresh must not make old analysis appear current or erase
an accepted artifact. Use the public company or job snapshot rather than
reading another feature's private tables.

## Source-Bound Claim Verification

The evidence and meaning of a claim are established by strict, cited model
determinations over the relevant sources. The application checks source and
revision identity, output structure, approval and other mechanical constraints;
lexical overlap, word lists and regexes do not decide support or equivalence.
The model gateway performs lane/spend preflight and records provider, model,
prompt and input provenance. Readers join recorded IDs rather than reinterpreting
text. Missing authority, invalid output, stale sources and provider failures
must be explicit and cannot replace accepted work.

The resume's coverage manifest records requirement, approved wording and source
IDs used for the actual assembled document. A wording gap describes the
chosen document, not a deficiency in the person. Review findings and user
acceptance have separate records and statuses.

## Stored Interview Preparation

Interviews owns its catalog, preparation, selections and independent notes.
Selected questions and accepted Profile evidence are bound to their revisions;
an explicit empty evidence selection stays empty. Unsupported claims remain gaps.
A failed refresh preserves accepted preparation and independent note history.
Notes or activity never silently become Profile facts, Fit evidence or an
application submission. The migrated product must retain existing interview
capabilities; parked expansions remain outside this transformation.

## Accepted Editable Export

Resumes owns editing, rendering and accepted artifact identity. An approval is
bound to the exact document and source versions. Accepted HTML, PDF, TXT or
DOCX outputs, where supported by the migrated feature, derive from that
accepted snapshot and are opened through owned metadata. A failed edit,
render, review or export cannot truncate or replace the previous accepted
artifact or bytes. Real renderer and export behavior require integrated proof.

## Reviewed Locale Variants

Translation and its review are linked to an accepted source and explicit source
and target locales. Review and acceptance are revision-bound; uncertainty and
unsupported terminology remain visible. See [locale variants](material-locale-variants.md).

## Reviewed Screening Answer Ownership

Applications owns screening-answer revisions and exact-payload approval. A
resume or locale approval does not itself approve an application action.

## Optional Company Briefings

Companies owns independent research and explicit company identity; consumers
use its public snapshot when available. Absence of a briefing must not make
manual Jobs unusable. Source and refresh failures remain visible rather than
fabricating company facts.

<a id="cover-letter-generation-policy"></a>
The earlier letter-generation policy is retired by the transformation; no
letter artifact or application attachment is part of the target contract.
