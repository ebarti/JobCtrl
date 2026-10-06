# Reusable Contact Identity Contexts

This investigation separates candidate-owned contact details, facts about an
outreach recipient, and the employer/application context in which those facts
are used. It proposes reusable identity contexts for
[issue #1017](https://github.com/ebarti/JobCtrl/issues/1017); it does not implement
new production behavior.

**Read this if** you need to decide how a reusable contact identity can retain
its source and history without silently changing an application or draft.

<a id="current-implementation"></a>

## Current implementation

The ownership map below is based on the inspected repository, rather than
historical phase descriptions. Current user behavior remains owned by
[Candidate Profile](../user/candidate-profile.md) and
[Contacts & Outreach](../user/contacts-and-outreach.md).

| Authority | Implemented boundary and source | Relevant tests |
| --- | --- | --- |
| Candidate facts | `PersonalInfo` in [profile/value_objects.py](../../workers/automation/src/jobctrl/domain/profile/value_objects.py) has one scalar email, phone, name and address bundle plus professional URLs. It has no identity-context collection. [ProfileSnapshot](../../workers/automation/src/jobctrl/domain/profile/snapshot.py) deep-copies canonical data and publishes an explicit version; compatibility evidence is derived from Profile. | [test_profile_snapshot.py](../../workers/automation/tests/test_profile_snapshot.py): metadata, explicit version, canonical/compatibility view, nested-copy and accessor isolation. |
| Candidate persistence | [Profile repository](../../workers/automation/src/jobctrl/infrastructure/profile/sqlite_repository.py) replaces normalized rows and increments the saved version; `load_snapshot` publishes that version. Candidate details are not Contact attributes. | Snapshot tests establish the read-copy boundary, not alternate candidate identity selection. |
| Recipient facts and association | [Contact](../../workers/automation/src/jobctrl/domain/contact/aggregate.py) owns `(TenantId, ContactId)`, one `ContactLink`, role, attributes and timestamps. [ContactLink and provenance](../../workers/automation/src/jobctrl/domain/contact/value_objects.py) require an employer and/or canonical JobId and provenance per attribute. Revising returns another aggregate with the same identity and creation time. | [test_contact_aggregate.py](../../workers/automation/tests/test_contact_aggregate.py), [test_contact_provenance.py](../../workers/automation/tests/test_contact_provenance.py). |
| Recipient persistence and reads | [SQLite contact repository](../../workers/automation/src/jobctrl/infrastructure/contact/sqlite_repository.py) writes `contacts` and `contact_attributes`; lists filter the current association. [UpdateContactUseCase](../../workers/automation/src/jobctrl/domain/contact/use_cases.py) preserves the attribute ID and provenance when `(kind, value)` is unchanged. [TypeScript contacts](../../apps/api/src/contacts.ts) owns the API write/read path and analogous fact preservation. | [test_contact_repository.py](../../workers/automation/tests/test_contact_repository.py), [contacts.test.ts](../../apps/api/test/contacts.test.ts), and [projection parity](../../apps/api/test/contact-projection-parity.test.ts). |
| Import identity matching | `importContacts` in [contacts.ts](../../apps/api/src/contacts.ts) evaluates CSV/vCard preview without writes and reevaluates commit inside a transaction. Valid normalized email/phone keys match across all nondeleted local contacts regardless of employer/job; conflicting matches are invalid. Without such keys, a full-record signature includes employer, JobId, role and normalized attributes. The Python CSV use case is a separate, simpler path; do not transfer the TS preview/dedup contract to it. | `contacts.test.ts` covers previews, duplicates, ambiguity, invalid links and commit revalidation. |
| Research proposals | [ContactResearchTask](../../workers/automation/src/jobctrl/domain/contact/research.py) stores candidates awaiting review separately from canonical contacts. [Confirmation use case](../../workers/automation/src/jobctrl/domain/contact/research_use_cases.py) preserves research provenance and marks attributes user-confirmed. [contact-research.ts](../../apps/api/src/contact-research.ts) hosts the frontend confirmation write path. Confirmation does not prove the recipient controls an address. | [test_contact_research_workflow.py](../../workers/automation/tests/test_contact_research_workflow.py): proposals, explicit promotion, provenance, source policy and candidate-value exclusion from events. |
| Outreach application context | [Draft use cases](../../workers/automation/src/jobctrl/domain/contact/outreach_use_cases.py) supply Profile evidence, contact facts, the contact's employer and an application-role argument. [OutreachThread](../../workers/automation/src/jobctrl/domain/contact/outreach.py) has a ContactId and optional JobId, with generation-versioned drafts. No reusable sender/recipient context version binding exists in these draft models. | [test_outreach_draft_gates.py](../../workers/automation/tests/test_outreach_draft_gates.py), [test_outreach_thread_aggregate.py](../../workers/automation/tests/test_outreach_thread_aggregate.py). |
| Approval and history | [Outreach gates](../../workers/automation/src/jobctrl/domain/contact/outreach_gates.py) combine a deterministic fabrication detector, content validator and model judge; approval uses persisted results. [Outreach repository](../../workers/automation/src/jobctrl/infrastructure/contact/outreach_repository.py) stores bodies, gate records and claim provenance canonically. Revisions preserve the approved generation until replacement approval. [outreach.ts](../../apps/api/src/outreach.ts) implements API approval/rejection. | Gate/aggregate tests, [outreach.test.ts](../../apps/api/test/outreach.test.ts), [test_outreach_no_auto_send.py](../../workers/automation/tests/test_outreach_no_auto_send.py). |

### Schema and privacy limits

[database.py](../../workers/automation/src/jobctrl/database.py) creates/adopts
exact schema version 12; [db.ts](../../apps/api/src/db.ts) admits the exact-v12
manifest. The legacy-named
[initializeExactV7Database](../../apps/api/test/v7-schema.ts) applies frozen v7
DDL and additive v8–v12 DDL, then stamps the supported version. Comments about
"Phase 1" or "exact-v7" are not evidence of a separate active runtime contract.
The Python [contact projection parity fixture](../../workers/automation/tests/test_contact_projection_parity.py)
deliberately calls `create_exact_v7_schema`: that case checks the shared contact
projection shape and tenant boundary on frozen v7, not runtime v12 admission.
The storage probes below create exact-v12 databases through current `init_db`.
Physical authorities remain defined in [Storage](storage.md).

Contact attribute values live in canonical `contact_attributes.value_json`;
contact events and contact projections carry identifiers, counts and provenance
metadata rather than attribute values. Read DTOs hydrate values from canonical
rows. This is a particular boundary, not a claim that all metadata is private
by construction: employer, JobId and source references can themselves reveal
context. Provenance validation requires nonempty references and known categories;
it does not establish reference redaction or external source authenticity.

Outreach claim provenance is computed against rendered paragraph text. It
matches recipient attribute values and sets `profile_grounded` when a qualifying
word matches the evidence corpus. That flag is not a semantic proof of every
claim in a paragraph. Relationship accuracy additionally depends on the model
judge. The generator sees the executive summary; the judge reads the top-level
`experience` metadata, distinct from the structured `resume.experience_entries`
([ExperienceMetadata](../../workers/automation/src/jobctrl/domain/profile/value_objects.py)).
The deterministic evidence corpus reads the broader Profile shape. Inspect the
actual inputs rather than assuming identical prompt coverage. Stored Contact
attributes are treated as the confirmed record by the composer; it does not
filter them by `user_confirmed` on each draft.

<a id="future-architecture-not-implemented"></a>

## Future architecture (not implemented)

The following is a proposal for #1017. New IDs, tables, selectors, migrations,
version fences and consumer contracts described here do not exist today.

### Keep three kinds of authority separate

| Proposed concept | Owner and permitted meaning |
| --- | --- |
| Candidate contact identity | Profile owns a named bundle of candidate-declared contact channels and presentation fields, such as a professional email and preferred display name. Selecting it cannot alter experience, skills, eligibility, attestations or factual achievements. Address control/verification, where required, is a separate fact from user declaration. |
| Recipient identity | Contact & Outreach owns a stable person ID with individually sourced facts and contact channels. Reuse of a person record does not assert a referral, employment or consent to contact. Email/phone matching is a reconciliation signal rather than proof of person identity. |
| Relationship/application association | Contact & Outreach owns explicit association records between the recipient and an employer and/or canonical JobId. Role, relationship claims, their sources and validity periods belong to this association where appropriate. An application's selected sender identity and selected recipient association are explicit consumer bindings, not mutations of the person. |

This separates "my professional reply address", "this recipient's email", and
"this person is the recruiter for this job". A name, common employer, shared
email domain or an imported note cannot establish a warm introduction. The
existing `WarmIntroSignal` value-object shape is not an implemented relationship
identification service.

### Selection and ambiguity

The proposed resolver takes tenant, purpose, canonical JobId when applicable,
explicit candidate identity ID/version, and recipient association ID/version.
It returns the selected values, sources, versions and a decision record, or a
reason selection is unavailable. Selection must be deterministic and reviewable:

1. An explicit saved selection wins only if its tenant, purpose, association
   and pinned version remain valid. A deleted or incompatible selection blocks
   the action; it does not switch addresses silently.
2. Without an explicit selection, a single user-configured default for that
   purpose may be offered for review. Multiple defaults or matching associations
   require user resolution. Employer similarity, model inference and latest
   modification time must not break a tie.
3. A recipient's identity can be reused across jobs, but each job association
   must be deliberately selected or created. Jobless outreach uses an explicit
   employer relationship context; it must not borrow another application's role.
4. Preview shows conflicts and proposed associations with no canonical writes.
   Commit revalidates sources and versions transactionally. A contact detected
   as a duplicate must not silently lose a new employer/job association.

The current import behavior makes the fourth rule consequential: identifier
deduplication can skip a record for a different job without adding that job's
association. A future design should offer "reuse person, add reviewed association"
separately from "skip duplicate". Different existing email/phone matches, recycled
addresses, shared inboxes and shared phone numbers require reconciliation. Do not
equate the present lowercase-email/digits-phone rules with international address
or phone standards, provider ownership verification, or general vCard compliance.

### Provenance, versioning and accepted artifacts

Each proposed fact keeps its source kind/reference, capture method/time,
confirmation status and immutable fact revision ID. Corrections append a new
revision; unchanged facts retain their original capture provenance. Association
facts carry their own provenance, distinct from person facts. A confidence score
does not grant permission or replace human confirmation.

Consumers should bind the candidate Profile version, selected candidate identity
revision, recipient fact revisions, association revision, job snapshot and
selection-policy version. Review should display which source supports candidate
claims, recipient facts and relationship claims independently. Generation must
receive only the selected, necessary fields. Explicit purpose restrictions must
exclude sensitive attestations, EEO data, passwords and unrelated contact notes.

A later edit should mark a binding stale for a new action and require review,
without rewriting an approved body, rendered resume, provenance or old decision.
Failed refreshes and rejected replacements retain the last accepted artifact and
the unsuccessful attempt. Approval must bind the exact candidate generation and
versions actually reviewed. This extends the existing preservation principle;
it does not claim current outreach approvals perform the proposed context fences.

### Privacy and migration

Keep contact values and selected snapshots in purpose-owned canonical storage;
events, projections and telemetry should use IDs, revision numbers and bounded
status metadata. Review source references for identifying query parameters,
filenames and free text. Access to a local database is not consent to send its
contents to a provider. Identity selection should disclose the bounded outbound
fields before generation. Retention and deletion need reference protection for
accepted artifacts and an explicit policy for historical sensitive snapshots;
reuse must not create indefinite implicit retention.

A future stopped-runtime migration would create one default candidate identity
from existing PersonalInfo and one recipient identity plus association from each
existing Contact, preserving ContactId/JobId references and attribute provenance.
It should not merge contacts by name, employer or identifier automatically.
Existing outreach bodies and accepted generations must remain byte-identical;
legacy generations without context-version evidence must be labeled as such,
not backfilled with invented generation-time facts. New foreign keys, uniqueness
rules, exact schema manifests, projections and both TS/Python adapters require
an explicit schema increment. A backup and row/reference reconciliation must
prove cutover and rollback; additive DDL alone is insufficient.

### Alternatives and future proof

Keeping today's scalar Profile bundle and single ContactLink minimizes migration
but cannot express multiple sender purposes or simultaneous recipient contexts.
Copying contacts per job expresses associations but duplicates facts and makes
corrections diverge. A generic shared "identity" aggregate conflates candidate
authority with recipient observations. The preferred proposal retains separate
owners and introduces explicit versioned associations and consumer bindings.

Before implementation is considered verified, demonstrate multiple sender
identities, shared recipient channels, conflicting identifiers, simultaneous jobs,
employer changes, tenant isolation, deletion and delayed commit conflicts. Prove
every generated claim reaches its correct canonical source and version, failed
generation preserves approved artifacts, events/projections exclude values, and
historical reads survive migration. Use synthetic imported-module tests plus
real API/browser review and worker integration with controlled model doubles;
live model accuracy and external-standard compliance require separate executed
evaluations. Outreach remains supervised with no automatic send or application
submission introduced by this proposal.

<a id="synthetic-evidence"></a>

## Synthetic evidence

The measured results below were produced by this implementation role against
Git revision `1ecb877dbb5275afeabfa6ca1ae872f88dbaaacb`, using the
controller-prepared `workers/automation/.venv/bin/python` (Python 3.12.13).
They use normally imported current modules and isolated invented profiles,
contacts and canonical JobIds. No provider, real account, send or submission
was used. They establish bounded repository/domain behavior, not a live-stack
or external-standard compliance claim.

### Measured outcomes

| Probe and retained run | Actual observation | Boundary and limit |
| --- | --- | --- |
| Original snapshot executable, `runs/snapshot-prepared/` | Mutating a returned email, nested bullet list and personal accessor left the snapshot's original email/name, one bullet and explicit version 7 intact; source Profile email was unchanged. Contact revision preserved ID, creation time and unchanged attributes. Linkless and URL-shaped JobId inputs raised the recorded expected errors. | Pure aggregate/snapshot probe, now executed in the prepared interpreter with UTC process receipts. The version 7 here is supplied snapshot metadata, not a schema version. |
| `contact-storage-probe-v2.py`, `runs/storage-v2/` | Profile repository saves returned versions 1 and 2; a load returned 2. The original snapshot retained `candidate@example.test` while the current snapshot contained `new-candidate@example.test`. | Saved-version progression and copy isolation over one exact-v12 database; no alternate identity selector exists. |
| Same storage probe: fact preservation | After contact reassociation and adding a phone, reloading preserved ContactId and creation time. Both unchanged name/email facts retained their attribute IDs and all imported provenance, including capture time and `synthetic.csv` source. The added phone carried `user_entered` provenance. | Calls the real update use case and SQLite repository, not a reimplementation of preservation rules. |
| Same storage probe: filtering | With two contacts, job-filter counts started at 1/1. Reassociating the first contact changed them to 0/2; tenant count remained 2. Exact old/new employer filters each returned 1. | Confirms the current single-association model. It does not measure a future multi-association design. |
| Same storage probe: research confirmation | A directly seeded synthetic research proposal left contact count at 2 until the explicit confirmation command. Confirmation changed it to 3 and completed the task. Source kind/reference, capture method/time and confidence stayed unchanged; `user_confirmed` changed from false to true. | Exercises proposal persistence and promotion, with no source fetch or extraction accuracy claim. |
| Same storage probe: outreach persistence | A clean draft passed and was approved. A revision inventing `250%` and `Initech Inc` failed deterministic gates despite the model double's PASS; approval raised the recorded rejection. After rejection and another revision with an unavailable judge, reloading showed three generations and the original approved ID/body intact. | Real repositories and public use cases, with four recorded model-double requests. No approval-version fence, model quality or send transport is established. |
| Same storage probe: rendered-text provenance | The approved greeting referenced `gamma-name` and was not profile-grounded; its experience paragraph was profile-grounded; the sign-off was not. The judge received top-level experience metadata with blank values, rather than the structured resume experience entries. | Actual prompts and gate/provenance records are retained. Neither lexical overlap nor a double's PASS validates every natural-language claim. |
| Same storage probe: value exclusion | Across 20 event rows, 3 contact projection rows and 1 research-task projection row, the 9 tested sentinel strings had zero matches. Sentinels included recipient names, addresses, a phone and both draft bodies. The database reported `user_version = 12`. | Checks these specific event/projection families and fixture values. It is not a universal privacy proof for metadata, logs, telemetry or every future writer. |
| Focused worker suite, `runs/worker-focused/` and `worker-focused.junit.xml` | 73 cases executed across all nine accepted worker test files: 73 passed, 0 failures, 0 errors, 0 skipped. | The exact locked command and full output are retained. `UV_NO_SYNC=1` used the broker-prepared environment without performing dependency preparation in this role. |

The original SQLite executable also completed in the prepared environment
(`runs/sqlite-original-prepared/`): its one-contact reassociation returned
job counts 0/1 and preserved unchanged attributes; its event/contact-projection
exclusion assertions passed. The original outreach executable completed again
(`runs/outreach-prepared/`) with explicit model doubles and in-memory repository
doubles. Its raw resume-only input produced a judge prompt with `experience =
null`; the normalized Profile-backed storage probe instead produced the
top-level metadata object. The inputs and exact prompts make that distinction
inspectable.

TypeScript import semantics in the ownership map are source/test inspection,
not results measured by these Python probes. Do not transfer Python results to
the TypeScript write path, infer vCard/email/phone standards conformance, or
equate a fixed model verdict with a live provider evaluation.

### Retained evidence and reproducibility

The durable controller allocation is
`run-22a5df595879/role-artifacts/authoring/implement/56c8b49350cdcd3fac36aa057876d0add91cd5dadfee98b1af5e9ecca9c9cb34/`.
It is outside tracked source; the controller seals its hashed snapshot for
independent inspection. Within it:

- `historical/` retains the exact input candidate document, all original
  executable blocks, complete original combined outputs and historical process
  metadata. The original host-interpreter SQLite import failure remains intact.
  The first historical snapshot attempt did not record UTC times; they are
  explicitly unknown rather than reconstructed. The prepared rerun has new UTC
  start/end receipts and does not relabel the old attempt.
- `run.py` is the executable subprocess runner. Each `runs/<label>/` retains
  separate complete original `stdout.log` and `stderr.log`, plus
  `receipt.json` containing argv, working directory, UTC start/end, exit status,
  deadline, timeout state, runtime, selected isolation settings and hashes.
  Successful reruns do not replace failed attempts.
- `contact-storage-probe-v2.py` retains the SQLite probe; the three exact original
  Python executables remain in `historical/`. `contact-import-probe-v1.mts`
  retains the original TypeScript import probe. Synthetic inputs are embedded
  in the originals and successful outputs; no measured result is assigned to
  an executable unless its retained receipt confirms execution.
- `source-lock-hashes.json` records exact SHA-256 hashes of inspected owning
  code/tests, exercised imported modules, schema inputs and dependency metadata.
  `artifact-hashes.json` binds executable revisions, complete outputs, receipts
  and JUnit evidence. `evidence-index.json` records outcomes and limitations.
- `broker-handoff/` retains the copied read-only controller receipts and full
  referenced logs, whose hashes were verified before copying. The handoff's
  SHA-256 is
  `2c3f768d3c3ea9b29a2dcaa1e9b374d1abe83c7878c5b9eab4cb495834848d4c`.
  Its baseline candidate
  `d8633518c386a6fb846672a6a3b9dcd5a6f890ac5ab4f0b3572165892077f7d6`
  differs from the input document candidate
  `71cb8f9c0a681dd6f9a8705bf4ce41d2cffff68a290052636d925bc1684d761f`.
  Baseline broker docs/runtime results are historical, not verification of this
  edited document. The Python preparation receipt establishes environment
  preparation, not feature behavior.

The exact dependency-lock hashes at this checkpoint are:

```text
f58933349adc295cad3ff96ba14d5cae6a62b37fcb83d12fe94a72063aaa0b75  pnpm-lock.yaml
c7a3609dab6c93fdaa9f247ef88a943d74629457042ce64d7a92320092ba40d6  workers/automation/uv.lock
```

To reproduce a recorded execution, run the retained runner from the repository
root with the receipt's original command and environment, but choose a new
label and a new nonexistent owned database path. The runner refuses to reuse a
run directory; the SQLite probes refuse existing databases. Python probes use
20- or 40-second alarms inside the process, with 40- or 60-second outer
deadlines. The focused worker run has a 300-second outer deadline and the
repository's per-case timeout. Process timings are receipts, not performance
benchmarks.

### Mandatory completion gates

The accepted delivery contract requires executed focused worker and API JUnit
evidence and independent review of claims against original outputs, source
hashes, anchors, issue link and single-file scope. Controller dependency
preparation and prepublication/final checks remain separate from this
implementation checkpoint. The tracked controller recipes are `checks.docs`
(`corepack pnpm docs:build`) and `checks.diff`
(`git diff --check origin/main...HEAD`). Browser/API QA, CI and publication
also remain controller responsibilities; their receipts belong outside source.
No browser-rendered diagram is introduced here.
