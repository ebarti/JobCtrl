# Interview rounds and actual-question history

Investigation and design for [issue #1034](https://github.com/ebarti/JobCtrl/issues/1034),
based on commit `1ecb877dbb5275afeabfa6ca1ae872f88dbaaacb`. The measurements below
exercise current imported components with synthetic data. The proposed round,
scheduling, participation and question-occurrence records are **future
architecture, not implemented**. This document changes no runtime contract,
database schema, calendar integration or interview workflow.

The useful continuity is between an application, a particular interview round,
the preparation the user actually consulted, and what the user later remembers
being asked. A preparation generation is neither a scheduled round nor proof
that an employer asked its selected questions. Keep these authorities separate.

<a id="current-implementation"></a>

## Current implementation

### Owners and canonical identities

The [Materials owner](materials.md#stored-interview-preparation) defines stored
preparation and personal question notes. [Storage](storage.md) owns the exact-v12
physical authorities. The [interview API owner](../api/jobs-and-materials.md#interviews-catalog-preparation-and-notes)
and [complete wire contract](../api/complete-contract.md#interview-catalog-preparation-and-notes)
own routes, dispatch, validation and errors; [outcomes](../user/outcomes-and-feedback.md)
owns reviewed application feedback. Operations composes reads rather than
creating a new interview history authority.

| Current record | Identity and authority | Owning source inspected |
| --- | --- | --- |
| Job | Tenant plus stable canonical UUID `JobId`; URLs are locators, company names are attributes | `workers/automation/src/jobctrl/domain/identifiers.py`; `apps/api/src/job-locators.ts` |
| Preparation attempt | `(tenant_id, job_id, generation)`; generated content, safety gate and retained context | `domain/interview/use_cases.py`, `domain/interview/value_objects.py`, `infrastructure/interview/sqlite_repository.py` under `workers/automation/src/jobctrl/` |
| Preparation item | Generation-scoped `item_id` and order; a question outline can bind a catalog card | The same repository and `domain/interview/question_generation.py` |
| Personal question note | `(tenant_id, job_id, question_id)` with its own monotonic revision | `apps/api/src/interview-notes.ts`; Python preparation repository; `schema_v12.sql` |
| Interview reflection | `application_outcomes.outcome_id`; manual `kind: "interview"`, optional pinned preparation generation | `apps/api/src/application-feedback.ts`; `packages/contracts/src/schemas.ts` |
| Contact | Tenant plus stable `ContactId`; attributes have separate IDs and provenance | `domain/contact/use_cases.py`, `domain/contact/aggregate.py`, `infrastructure/contact/sqlite_repository.py` under the worker |
| Public question card | Stable editorial question ID plus catalog/card/rubric revisions and digests | `domain/interview/catalog.py`; packaged `assets/interview/catalog.v1.json`; [catalog contract](../research/interview-preparation/catalog-contract.md) |

The inspected schema and interview contracts have no scheduled-round or
actual-question-occurrence authority. Stage and format already exist in a
generation's input context, but they do not identify a round or retain a schedule.
An outcome occurrence time is not an appointment, and a note keyed to a reusable
question family cannot distinguish that question appearing in two rounds.

`resolveJobLocator` first looks for a unique tenant-scoped JobId, posting URL or
posting alias. Only then does it consider canonical application URLs and retained
application aliases. A shared application endpoint returns no job. Posting
identity wins over an application alias. [Application URL authority](application-url-authority.md)
explains the wider ownership. A round must store the resolved tenant/JobId,
not repeatedly resolve a mutable URL or group applications by company text.

Contacts similarly cannot be identified by a name, email or employer string.
The imported Contact use cases preserve unchanged attribute identity/provenance
and stamp changed values as user-entered. A Contact's employer, job link and role
can change while its ContactId remains stable. Two Contacts can have the same
employer string without being the same person. The existing Contact role is an
application/employer relationship; it does not establish that person's role in
a particular interview panel.

### Preparation: selection, generation and retained acceptance

`workers/automation/src/jobctrl/interview/activities.py` reads the canonical
preparation target, versioned profile and canonical accepted achievement evidence.
It validates selected card IDs, evidence membership and profile version before
constructing the provider adapter. It refreshes projections, reads coherent
employer/requirement-fit context, and loads approved registered material inputs.
Stale or unavailable inputs are excluded/labeled rather than promoted into
personal evidence. `test_interview_generation_persistence.py` covers activity
reads, explicit empty evidence selections, projection context, safe events and
unavailable material paths; `test_interview_review_regressions.py` covers rejected
coerced evidence and unsupported assertions.

`domain/interview/preparation.py` normalizes selection and plans evidence before
prose. Explicit selection preserves 1–16 unique active card IDs. Unknown,
retired, duplicate, over-budget or stale catalog bindings reject before spend.
Omitted selection uses a bounded deterministic suggestion, ordinarily five
questions; this is guidance, not observed employer frequency. Stage defaults to
`unknown`, format to `unspecified`, and role lens to `unknown`. An explicit empty
evidence list stays empty; omission permits deterministic evidence selection.
New recollections and notes are not accepted-profile evidence.

`generation_context` retains catalog binding, ordered selected IDs, complete
selected card snapshots, card/rubric revisions and digests, answer formats,
rationale, evidence-selection modes/IDs, profile identity/version and selected
excerpts, job snapshot hash/excerpt, bounded employer context, fit binding,
approved material byte hashes, and model/prompt/gate versions. Its
`contextDigest` seals canonical sorted-key compact UTF-8 JSON before that digest
field is added. Item `questionMetadata` separately retains the outline, gaps,
probes and evidence links. A catalog/card digest is distinct from an approved
resume's byte hash and from the full generation context digest.

`GenerateInterviewPrepUseCase.execute` calls the fake-or-configured provider for
a candidate, parses question items, runs deterministic truthfulness gates, then
calls the adversarial safety judge. A safety pass is not calibrated rehearsal
grading or evidence of interview readiness. Candidate errors, truthfulness
rejections and judge errors/rejections persist failed attempts with no accepted
items. Failure to save candidate items rolls back the candidate transaction,
then attempts to persist a failed generation. If even failure-history
persistence fails, the exception can escape; this investigation does not claim
that every storage failure produces a completed failed row.

The repository allocates the next number from `MAX(generation) + 1`. On save it
uses a savepoint, rejects a number at or below the stored maximum, supersedes
older accepted rows only for a new accepted generation, and saves its items and
context together. A failed generation never supersedes the accepted one. This
is a persistence fence, not a reservation or proof of concurrent scheduling.
The probe tested sequential late/colliding writes, not a concurrent allocator
race or automatic recovery from that race.

`origin_run_id` reuses a completed attempt for that tenant/job/run, including a
failed attempt. Both the activity and use case check it before another provider
call. A historical superseded generation is still returned as an accepted
outcome for the originating run, while its stored history status remains
superseded. The probe measured accepted and failed retry reuse; the superseded
retry interpretation is from the inspected `_outcome_from_existing` code.
An origin run is an execution identity, not a round identity.

The Python projection builder's `_load_interview_prep` and the TypeScript
projection reader in `apps/api/src/projections.ts` read canonical preparation
rows. `apps/api/src/server.ts` replaces the job-detail top-level prep with
`loadLatestAcceptedInterviewPrep`, independently of stale/null projection JSON
or pagination dominated by failures. `apps/api/src/interview-prep-history.ts`
reads retained generations and derives current-input diagnostics. Its checks
are catalog, profile, job, employer analysis and approved materials; there is
no independent fit-report comparator in this function. Diagnostics do not
rewrite retained context or prove when an interview took place. Legacy null
context/metadata remains unbound, with `legacy_unbound`; no catalog association
is invented by the v12 migration or read model.

### Note revisions and post-interview reflections

Preparation replacement does not overwrite `job_interview_notes` or
`job_interview_note_revisions`. Expected revision zero creates revision one;
subsequent saves compare the exact current revision and append the new saved
row to the archive atomically. Stale edits and archive failures leave the
current note and archive intact. Python savepoints also preserve a caller's
outer transaction. Notes default to `unverified_user_statement` and
`user_edited`; neither a generated safety pass nor a user-supplied support label
can make them verified profile facts.

At the API service boundary, `saveInterviewNote` derives authoritative bindings
from the retained source generation's selected card, or from the current catalog
for an independent note. It rejects a source that lacks that question and forged
binding claims. After preparation deletion, an ordinary edit of an existing note
detaches its missing origin; its earlier archive still retains that origin.
Explicitly requesting a missing origin rejects instead. Independent means
independent of a prep generation; a note can still carry a catalog/card binding.
The lower-level Python repository validates source-generation existence and
stores supplied bindings; it does not implement the TypeScript service's
selected-card derivation policy. Future writers must enforce their owning
validation boundary rather than treating these layers as interchangeable.

Manual reflections persist through `recordManualApplicationOutcome` in Apply's
existing outcome authority. The request schema allows `interviewPrepGeneration`
only with `kind: "interview"`. Resolution accepts an existing accepted or
superseded generation for the same local tenant/job and rejects failed, missing,
other-job and other-tenant rows. The link is optional and generation-specific.
It does not record individual questions, interviewer participation, schedule
revisions or employer confirmation. Private reflection text remains in outcome
storage; `ApplicationOutcomeRecorded` carries safe IDs, kind/source/time and
`notePresent`, not the text. Note events similarly contain identities, revision,
origin and time, excluding note text and generation context.

<a id="synthetic-evidence"></a>

## Synthetic evidence

Measurements were made on 7 October 2026 against the pinned source above, in the
owned task checkout. The controller-prepared project Python was CPython 3.12.13
on macOS arm64, with SQLite 3.50.4. The recorded Node interpreter was v22.21.1,
arm64, modules ABI 127; the prepared better-sqlite3 binding reported SQLite
3.53.0. Corepack used pnpm 10.24.0 and the repository tsx 4.22.4 loader.
Different SQLite builds are recorded rather than presented as cross-platform
equivalence. Private receipts retain exact interpreter/module paths,
environment, UTC timestamps, command arguments, exit codes and elapsed times.

`run.py` establishes synthetic workspace variables before starting imports and
enforces a 240-second process-group deadline. The Python probe normally imports
`GenerateInterviewPrepUseCase`, `InterviewPrep`, `create_exact_v12_database` and
`SqliteInterviewPrepRepository`. Production functions are not copied or evaluated
out of source. Existing test helpers supply explicitly synthetic profile,
candidate, judge and canonical evidence inputs, with source hashes retained.
The TypeScript program normally imports production services through tsx and
uses the existing fixture schema initializer; despite its historical
`initializeExactV7Database` name it creates and admits exact v12. Provider
transport is fake; disposable databases never use an account or existing user
workspace.

### Observed behaviors and limits

| Measurement | Actual observed result | Bounds and retained artifact ID |
| --- | --- | --- |
| Initial acceptance and same-run reuse | Each Python fixture accepted generation 1 with two provider calls. Replacement generation 3 and its retry also used two calls total | One selected B01 card and one accepted synthetic profile evidence record; `authoring/python-probe-attempt-2.stdout` |
| Failed provider refresh | Generation 2 failed with `generation_error`; one call including same-run retry; accepted generation 1 and revision-1 note unchanged | Explicit injected provider exception; `authoring/python-outcomes.json` |
| Judge exception and judge rejection | Both persisted failed generation 2; two calls each including retry; accepted content/context and note unchanged | One unavailable judge, one synthetic fail verdict; same outcome artifact |
| Item-persistence failure | An INSERT trigger aborted new items, then failed generation 2 persisted with `persistence_error`; two calls including retry; generation 1 intact | Trigger targets items only, allowing failure-history save; same outcome artifact and complete stderr |
| Successful replacement and reopen | History became `(3, accepted), (2, failed), (1, superseded)` in all four fixtures. Old item/context hashes stayed identical; latest accepted 3 survived connection close/reopen; note survived | Four isolated Python refresh databases; `authoring/python-snapshots.json` |
| Late generation fences | Writes at generation 1 and colliding 3 rejected in each fixture; no late accepted replacement | Eight sequential injected conflicts; no parallel load or Temporal scheduling test |
| Note CAS/archive rollback | Stale revision zero rejected. Valid second edit created revision 2, archive order `[2, 1]`. Injected archive failure left both unchanged and caller transaction open; caller rollback restored its pending job edit | Four Python fixtures; actual exceptions in stdout, not inferred from final row alone |
| Contact continuity | One imported Contact kept ContactId and unchanged name attribute/provenance after employer/job/email changes; edited email became user-entered. Original-job list empty, new-job list size one, other-tenant lookup absent; two distinct Contacts shared the employer string | One CSV row and a second employer-only Contact; fifth Python database; stdout contains safe original event payloads |
| Note origin and deletion | Derived TS09 note pinned source 1 and retained context binding; independent TS10 had null generation/context binding. Source mismatch, forged binding and stale revision rejected. Ordinary edit after source deletion detached to null; archive origins were `[null, 1]` | One exact-v12 TypeScript database and two synthetic cards; `authoring/typescript-probe-attempt-3.stdout` |
| Derived staleness | Baseline `[]`; changed catalog argument, saved profile version and saved job description produced `catalog_changed`, `profile_changed`, `job_changed`. Stored context hash unchanged. Null context gave `legacy_unbound` | Missing-analysis and missing-material comparators separately exercised by mismatching retained fixture bindings, not real employer analysis or resume generation |
| Reflection continuity | Accepted 2 and superseded 1 linked; unlinked reflection retained null. Failed 3, missing 9, other-job 10, other-tenant 11 rejected, leaving three outcomes. Valid non-interview `rejection` plus prep link rejected by request schema | Synthetic direct services/schema; superseded row was reseeded after the note-deletion scenario, not regenerated by a workflow |
| Canonical job lookup | Unique application alias resolved; adding another local job with that alias returned null. Missing tenant returned null; stable IDs resolved within their tenant; posting identity won over another job's application alias | Three synthetic job rows across two tenants; no external URL fetch |
| Event minimization and API archive rollback | Six note/outcome events contained no synthetic private note/reflection text or context digest. Injected API archive failure left revision 2 and event count six unchanged. Contact events excluded attribute values | Complete queried payloads retained, not only an event-count assertion |

In the final Python run, every accepted-before/accepted-after read-model digest
pair matched across its failed refresh. Full snapshots and the digest inputs are
retained, not just equality assertions. The common retained context digest was
`5956124eb1def179925180b6ae701d1d315d80a6e9d94fe3f67a9f20fe9f4c21`;
the common item digest was
`f8728292054af8c443b5e038bc28459f8e64319c444af522b7190d5ac013c496`.
These fixture-content hashes use sorted-key compact UTF-8 JSON. Full preparation
hashes include generated timestamps and therefore differ between independent
runs. The TypeScript retained-context comparison hashes JSON serialization of
the saved JSON string, and is not the semantic `contextDigest` algorithm.

The initial Python attempt passed; a second passed run additionally retained
complete before/after/reopened snapshots and imported-source hashes. Both
original programs and outputs remain. The first TypeScript CLI attempt exited
1 before domain imports with `EADDRINUSE` while creating its local IPC pipe.
Attempt 2 used the recorded Node interpreter with the repository tsx loader and
passed. Its negative non-interview test initially used the invalid enum value
`rejected`, which demonstrated enum rejection rather than the intended
interview-only-link rule. Attempt 3 corrected the fixture to valid `rejection`,
passed, and observed the specific schema refinement error. Earlier evidence is
retained with its actual interpretation. Provider, judge, item and archive
exceptions in the completed probes were deliberately injected. Python provider,
judge and item-failure tracebacks remain in private stderr. Both probes catch
archive exceptions and record their type and message in stdout; completed
TypeScript stderr is empty. The complete original streams remain retained.
No unexpected domain failure remained in the final probes.

The first evidence-table insertion also failed because the initial source
manifest omitted the packaged catalog asset. The manifest was corrected against
the pinned commit's exact bytes before inserting its hash. The original error
and prior inventories remain in local evidence; this authoring error did not
execute or change a domain component.

### Focused regressions and reproduction

The controller had already prepared locked dependencies; the author did not
install or resolve another environment. The worker invocation added `--no-sync`
to reuse that prepared environment and `python -m pytest` to select its
interpreter explicitly. It executed all required selected cases: **123 passed,
zero failures/errors/skips**. The API invocation executed **72 passed, zero
failures/errors/skips**, confirmed from original JUnit test cases. These are
imported/service and in-process API regressions, not browser or running-stack QA.

Portable command forms below substitute only the controller-owned evidence
directory and prepared tool paths. Exact original argv and environment remain
in local receipts; these forms are not an instruction to choose a new interpreter.

```sh
uv --project workers/automation run --locked --all-extras --no-sync python -m pytest -q \
  workers/automation/tests/test_interview_generation_persistence.py \
  workers/automation/tests/test_interview_persistence_v12.py \
  workers/automation/tests/test_interview_review_regressions.py \
  workers/automation/tests/test_interview_catalog.py \
  --junitxml="$EVIDENCE_DIR/worker-regressions.junit.xml"

corepack pnpm --filter @jobctrl/api exec vitest run \
  test/interview-prep-history.test.ts test/interview-notes.test.ts \
  test/interview-persistence-v12.test.ts test/interview-catalog.test.ts \
  test/application-feedback.test.ts --reporter=junit \
  --outputFile="$EVIDENCE_DIR/api-regressions.junit.xml"

"$PREPARED_PYTHON" "$EVIDENCE_DIR/python-probe.py"
"$RECORDED_NODE" --import "$REPOSITORY_TSX_LOADER" "$EVIDENCE_DIR/typescript-probe.mts"
```

For probes, set `PROBE_ROOT` to this checkout and `PROBE_OUTPUT` to the owned
evidence directory. `run.py` records the prepared Node/Corepack environment and
sets `PYTHONPATH` to the worker source and test-helper roots, plus isolated
workspace variables, before executing. It requires the supplied handoff receipt
and validates its hash. The portable inventory identifies original executable
sources, synthetic inputs, both output streams for every attempt, command
receipts and original JUnit files. Inputs are deterministic; generated IDs and
timestamps are not. The hash of each individual investigated source/lock file is
in `source-hashes.json`; `python-import-hashes.json` additionally records the
actual local Python import closure. No evidence file is a repository dependency.

### Retained evidence inventory

Artifact IDs are relative to the controller-retained authoring evidence bundle,
not repository links or public download URLs. The controller retains that bundle
through scratch cleanup. SHA-256 identifies exact original bytes; it does not
assert that private raw logs are suitable to publish. Absolute command paths,
module paths and original tracebacks remain only in local evidence. Public
citations below disclose portable IDs and hashes. `measurement-index.json`
inventories the retained measurement sources, inputs, outputs, receipts and
earlier attempts. Subsequent document-check receipts and the controller's
publication receipts are separate.

| Retained artifact ID | SHA-256 |
| --- | --- |
| `authoring/measurement-index.json` | `bd3ca917acd30668d07a753038f7103474a68cccf7dec72fbb7d6fece04b63f9` |
| `authoring/source-hashes.json` | `44250d718096ae679a121b95629946d8f463a0af36216d49b5ec8dcedce23a28` |
| `authoring/python-import-hashes.json` | `b4d7c8ed77b5002ab8f06213b18ab8acba2b8d299ad9a704a59a533536aa53f5` |
| `authoring/run.py` | `191918b931ce751a471087040bba3b8fce1db9f5c6beecdf8949e70cbee4b10b` |
| `authoring/python-probe-attempt-1.source.py` | `44a8f34eb58ac64eaaa0b706124fb025ee14172fd240b5f01410807641c5aca5` |
| `authoring/python-probe.py` | `7c343a76c2bedd9c15b7f5f875e9416b6d120e86caae0454772f57715896bd58` |
| `authoring/python-inputs.json` | `cc7e9c77292023d11d1de3c7e09d821f3a486132adf85660bd4fbeb857ee4981` |
| `authoring/python-attempt-1.inputs.json` | `cc7e9c77292023d11d1de3c7e09d821f3a486132adf85660bd4fbeb857ee4981` |
| `authoring/python-attempt-1.outcomes.json` | `8cf45e6c7ac40f34ee7a9a23936ad5ebba6d13921e2fab101d5c3d3233667240` |
| `authoring/python-outcomes.json` | `ed8968f17079f3ea066fe6c166c51ad60b3083782b3e9149ea0c4ec5a69a2730` |
| `authoring/python-snapshots.json` | `188cb7f7ce9e76b788f4db2ac2af116254604e1e27779a0ddb206ba2e3f18cf4` |
| `authoring/python-probe-attempt-1.stdout` | `b2715fc3dbf46b6a8ff62771734f1d3707aad28a0e7fa764223d5d02148cb3bb` |
| `authoring/python-probe-attempt-1.stderr` | `9d2d4fe19d279e8bd2a6a5150636072321c3ea3efef940c5be0e5811cec82a12` |
| `authoring/python-probe-attempt-2.stdout` | `f7cb32e36ac5ad52223d31c1fd90cf958d1cb09827eac0ee1fb4942859183a08` |
| `authoring/python-probe-attempt-2.stderr` | `9d2d4fe19d279e8bd2a6a5150636072321c3ea3efef940c5be0e5811cec82a12` |
| `authoring/typescript-probe-attempt-1.source.mts` | `1779e9d4b534cf364904e33b097e8677c74cb559526a56b00d05499f943efcf1` |
| `authoring/typescript-probe-attempt-2.source.mts` | `1779e9d4b534cf364904e33b097e8677c74cb559526a56b00d05499f943efcf1` |
| `authoring/typescript-probe.mts` | `69fc157a4821cc4e1255eeb6ce8bc75f7fc5fd778957924088935ece6c803b22` |
| `authoring/typescript-inputs.json` | `a460f75a4de17f9c948fe459c102f8fd5cd1afc48dae7742363b9a7b82390017` |
| `authoring/typescript-probe-attempt-1.stdout` | `6a6b35294a9fc4df0321991141fab333e087ff266d57fc405068e2aa7faab9f2` |
| `authoring/typescript-probe-attempt-1.stderr` | `dd8aa04d04a3d541f92f1163b1f75c546572d1f4678987500a6e4785f016ec18` |
| `authoring/typescript-probe-attempt-2.stdout` | `82a0f269917e6347974ec75ba422b25da4f15209d38db1adad920499eeccd63e` |
| `authoring/typescript-probe-attempt-2.stderr` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `authoring/typescript-probe-attempt-3.stdout` | `9e1ec50df280cefb122b253fcd47319b209702ededc15564f28da20bda9fe2d2` |
| `authoring/typescript-probe-attempt-3.stderr` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `authoring/worker-regressions.stdout` | `efe288e2b354f91cc2108084cbfb6e858042ac82cf1428eba92c594603f8e121` |
| `authoring/worker-regressions.stderr` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `authoring/worker-regressions.junit.xml` | `21593f7f2251f1d6bcfe1d647183e2f79a8925f3e23f184bb3e88f5c8ba7d300` |
| `authoring/api-regressions.stdout` | `4207c46c78603e71f69e49e6f4161c46e5d0d7656204334e1484bf76480f236b` |
| `authoring/api-regressions.stderr` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `authoring/api-regressions.junit.xml` | `c919f8a7ac6a7f3aa3fd810f019882ff9e06d8e8850dda80357139b75b6a1ec2` |

The command receipts for every listed run are also individually hashed in the
inventory as `authoring/<run-id>.receipt.json`. Key frozen inputs are:

| Repository input | SHA-256 |
| --- | --- |
| `workers/automation/uv.lock` | `c7a3609dab6c93fdaa9f247ef88a943d74629457042ce64d7a92320092ba40d6` |
| `pnpm-lock.yaml` | `f58933349adc295cad3ff96ba14d5cae6a62b37fcb83d12fe94a72063aaa0b75` |
| `scripts/checks.toml` | `cbe4620f5a1c92ee723b8edaae74af3b2a0f07c97d8698d9cf514352548915fa` |
| `workers/automation/src/jobctrl/assets/interview/catalog.v1.json` | `20fab11dab969ecd619f1c98fe1ae6e6b46392019f6d48322952de5d832d121f` |
| `workers/automation/src/jobctrl/infrastructure/migrations/schema_v12.sql` | `b1beed1e0b508cbc4420059d9c64abf83e3aca1606bfbacad4f900aef56c5189` |

The source manifest includes the catalog asset, schema resources, use cases,
repositories, readers, events, tests, `workers/automation/uv.lock`,
`pnpm-lock.yaml`, and `scripts/checks.toml`. The imported packaged catalog had
121 active questions, 15 topics, 57 source records and 20 author groups, all
research-draft content. Its semantic digest was
`fcea1ff4717dc0faa639f10a668faf12dcbc842991affb0a8cad5c9eca6b1dfd`;
this is distinct from the raw resource SHA-256 in the source manifest.
Copied broker baseline/preparation receipts retain their original candidate
identity and logs in `historical/` and `historical-inspection.json`. They are
historical source/environment observations, not proof of this edited document.

No live provider, external account, real profile, message, submission, employer
observation, calendar service, running Temporal worker, installed release,
browser flow or production deployment was exercised. The native probes comprise
five Python fixture databases per run and one TypeScript database per completed
run. Existing regressions broaden failure/isolation coverage, but these bounds
do not measure performance, distributed races, real provider quality, employer
practice or hiring predictions.

<a id="future-architecture-not-implemented"></a>

## Future architecture — not implemented

### Distinct identities and ownership

Extend Materials with job-scoped round continuity and occurrence records, while
Apply keeps reviewed outcomes and Contacts keeps canonical people/attributes.
Operations should compose their read models. This is a proposed allocation,
not a newly shipped bounded context or route family.

| Proposed authority | Stable identity | What it establishes |
| --- | --- | --- |
| Interview round | `(TenantId, JobId, RoundId)` | One user-recorded interview encounter, even after rescheduling |
| Round revision | Round plus `revision` | Context/lifecycle change with actor, time, source and expected-revision fence |
| Schedule revision | Round plus `ScheduleRevisionId` | A proposed/confirmed/corrected appointment; never a new prep generation |
| Round participant | Round plus `ParticipantId` | A person's role in this encounter, optionally linked to tenant-scoped ContactId |
| Preparation link | Round plus `PrepLinkId` | Exact retained prep generation consulted/selected and the round revision used for selection |
| Question occurrence | Round plus `OccurrenceId` | One user-recorded instance of wording actually asked, not a card definition |
| Occurrence revision/catalog association | Occurrence plus revision/association ID | Corrections and optional editorial-family matching with explicit provenance |
| Reflection link | Round plus retained outcome ID | Navigation to Apply's reflection without copying its private text |

Keep RoundId stable through cancellation, rescheduling and correction. A later
distinct encounter receives a new RoundId, optionally `followsRoundId`; an
ordinal is a sortable display attribute, not identity. A panel session is one
round with several participants unless the user records separate encounters.
Unknown sequence/stage/interviewer stays unknown. A repeated question has a new
OccurrenceId each time; identical wording is not a deduplication key.

### Proposed records and invariants

The following is a design sketch, **not an existing TypeScript contract or
migration**. Composite tenant/job ownership applies to every child reference.
Stored private labels, wording and notes are excluded from notification events.

```ts
type RoundState = "draft" | "planned" | "completed" | "canceled";
type RoundFormat = "unknown" | "phone" | "video" | "onsite" | "written" | "hybrid";

interface InterviewRound {
  tenantId: TenantId;
  jobId: JobId;
  roundId: RoundId;
  revision: number;
  state: RoundState;
  ordinal: number | null;
  stage: "unknown" | "recruiter" | "behavioral" | "management"
    | "technical" | "executive" | "mixed";
  format: RoundFormat;
  currentScheduleRevisionId: ScheduleRevisionId | null;
  followsRoundId: RoundId | null;
  actualStartUtc: string | null;
  actualEndUtc: string | null;
  recordedAtUtc: string;
  deletedAtUtc: string | null;
}

interface ScheduleRevision {
  tenantId: TenantId;
  jobId: JobId;
  roundId: RoundId;
  scheduleRevisionId: ScheduleRevisionId;
  revision: number;
  certainty: "proposed" | "user_confirmed" | "unknown";
  startUtc: string | null;
  endUtc: string | null;
  localStart: string | null;
  timeZone: string | null; // IANA identifier; null means unknown
  chosenOffsetMinutes: number | null;
  precision: "instant" | "local_date" | "unknown";
  dstResolution: "unambiguous" | "earlier" | "later" | "unknown";
  recordedAtUtc: string;
  source: "user_entered" | "user_corrected";
  supersedesScheduleRevisionId: ScheduleRevisionId | null;
}

interface RoundParticipant {
  tenantId: TenantId;
  jobId: JobId;
  roundId: RoundId;
  participantId: ParticipantId;
  contactId: ContactId | null;
  roles: Array<"recruiter" | "hiring_manager" | "peer" | "technical_evaluator"
    | "panel_chair" | "observer" | "other" | "unknown">;
  privateLabelSnapshot: string | null;
  attendance: "expected" | "attended" | "absent" | "unknown";
  source: "user_entered" | "user_corrected";
}

interface QuestionOccurrence {
  tenantId: TenantId;
  jobId: JobId;
  roundId: RoundId;
  occurrenceId: OccurrenceId;
  revision: number;
  order: number | null;
  parentOccurrenceId: OccurrenceId | null; // follow-up in the same round
  participantId: ParticipantId | null;
  wording: string;
  wordingKind: "reported_exact" | "paraphrased" | "fragment" | "unknown";
  source: "user_recollection" | "user_entered_permitted_notes" | "user_correction";
  certainty: "confident" | "uncertain" | "unknown";
  askedAtUtc: string | null;
  recordedAtUtc: string;
  correctionOfRevision: number | null;
  deletedAtUtc: string | null;
}

interface OccurrenceCatalogAssociation {
  tenantId: TenantId;
  jobId: JobId;
  roundId: RoundId;
  occurrenceId: OccurrenceId;
  associationId: AssociationId;
  questionId: string;
  catalogRevision: string;
  catalogDigest: string;
  cardRevision: string;
  cardDigest: string;
  relation: "reported_same_wording" | "similar_family" | "possible_match";
  decision: "suggested" | "user_confirmed" | "user_rejected";
  source: "user_selected" | "derived_suggestion";
  recordedAtUtc: string;
}
```

Future SQL should use composite primary/foreign keys rather than trust a global
ID alone. Require same tenant/job/round for follow-up and participant references,
acyclic follow-up parents, positive revisions, bounded text and bounded arrays.
Optional order is user-recorded sequence, not generated rank; unordered partial
recollections need not invent a sequence. Permit several follow-ups and several
possible catalog associations. Confirmation of a match establishes only the
user's editorial association, not employer verification of a question family.

### Scheduling, timezone and lifecycle

`draft → planned → completed` is the ordinary user-recorded lifecycle; draft or
planned can become canceled. Rescheduling changes the schedule revision and
pointer without replacing the round. Corrections to completed/canceled records
require a reason and expected revision, retaining the prior state; a deliberate
reopening is a correction, not silent state inference. Completing a round is an
explicit user action. Passing the scheduled time, a reminder or an interview
outcome cannot automatically establish completion or attendance. An unscheduled
recollection can be recorded as a completed round with unknown appointment
details. Mark deleted records separately from canceled ones.

For known appointments store both the UTC instant and IANA timezone plus entered
local time and chosen offset. Render in the recorded zone by default, with a
clearly labeled viewer-zone conversion. A date-only observation stores a date
and precision, leaving instants null; unknown zone is not replaced with the
machine's default. A DST gap must reject the nonexistent local time and request
a valid time. A DST fold requires an explicit earlier/later offset choice.
Keep that choice and original representation, so timezone database updates do
not silently move a historical appointment. An end must follow its start;
unknown duration remains null. Rescheduling retains the earlier schedule and
its provenance. UTC recording time, planned time and user-reported actual time
have different meanings and clocks.

Stage describes the intended evaluation context; format describes how the
encounter happens. Video does not imply technical, onsite does not imply panel,
and a role lens is candidate preparation context, not interviewer seniority.
Confirming a schedule does not confirm a stage, interviewer or employer criterion.
Meeting links, location details and free-text employer labels are sensitive
local fields. Calendar/reminder integration is deferred; a later adapter would
need explicit authorization and its own provider/external-identity ownership.

### Participants, preparation and actual questions

Participants may remain anonymous/unknown. Bind ContactId only after a
tenant-scoped lookup and explicit selection; do not match automatically by email
or company. Keep the round-specific role and a permitted minimal label snapshot
so Contact edits do not rewrite past attendance. A Contact changing jobs does
not move an old round. Contact deletion should detach the optional live reference
and apply the user's retention choice to the snapshot, not delete the round or
silently retain erased personal labels forever. No outreach research or message
sending is implied by adding an interviewer.

Pin a preparation link to an accepted-or-superseded generation for the same job,
with its context digest, selection/consultation time and round revision. Reject
failed generation links. Keep a deliberately selected older generation readable
even when current inputs produce stale reasons. A new generation creates a new
link after explicit selection; it does not update all rounds to “latest.” Failed
refreshes preserve the previous link and accepted artifact. Do not retroactively
add a RoundId to an immutable generation context; the relationship belongs in a
separate link record. Legacy unbound prep can be linked as legacy preparation
without inventing its catalog or evidence bindings.

An occurrence records what the user reports was asked after the encounter.
`reported_exact` describes the user's wording claim, not independently verified
verbatim truth. Separate paraphrase, fragments, uncertainty and recording time
from the question's possible ask time. Permit unmatched questions outside the
installed catalog and repeats within/across rounds. A follow-up points to its
parent occurrence; changing order or wording appends a revision rather than
changing OccurrenceId. A participant association can stay null. No guessed
employer question, generated outline, practice question or source example can
become an actual occurrence automatically.

Catalog matching is optional and versioned. It does not replace original
wording or collapse occurrences into cards. Retain association decisions and
the referenced revision/digest; a newer catalog may suggest a new association
but cannot rewrite historical ones. Retired/absent cards remain readable via
retained minimal snapshots where permitted, or an explicit unavailable binding.
User correction of an incorrect match must not erase the underlying question.
Future model suggestions must be separately labeled and require confirmation.

Apply reflections remain outcomes. A future round-outcome link must validate
same job, manual interview kind and compatible pinned prep if a prep link is
also supplied. Do not copy outcome text into a second authority or turn one
outcome into a fabricated schedule. Existing outcomes and per-card notes can
remain unassigned. Linking them later requires user confirmation; a generation
or shared question ID is insufficient to infer a round or occurrence.

### Corrections, preservation, deletion and migration

Future mutations should use expected-revision compare-and-swap and atomically
save the current row, its revision history and safe notification. Conflicts
return the current version while preserving the user's draft. Failure to append
history must roll back the current-row change, as the measured note behavior
does today. Store correction actor/source/time/reason; distinguish correcting a
recollection from adding a newly remembered question. Idempotency keys should
prevent duplicate command delivery, while identical wording alone must not
merge distinct occurrences.

Retention must explicitly cover private wording, participant labels, schedules,
reflection pointers, revisions and retained bindings. Deleting prep must not
erase independently recorded occurrences or notes; detach live links with an
honest missing-origin state. Deleting a round must not delete shared prep, a
Contact, Profile facts or Apply outcomes. Soft deletion should hide the round
and its occurrence graph consistently, with recovery subject to retention;
explicit permanent deletion must erase private current/history content and
associated links, not leave the same text in revision archives or projections.
Job purge should cascade all new tenant/job-owned rows and leave other jobs and
tenants intact. Any minimal deletion receipt must exclude the erased content.
This proposal must integrate with the existing [sensitive-artifact retention
proposal](../plans/sensitive-artifact-retention.md), not assert an implemented
cleanup guarantee.

A future exact-schema migration should add empty authorities, verified composite
references and explicit version admission. Preserve every existing generation,
context, note revision and outcome. Backfilling rounds from prep timestamps,
stages, company strings or outcome text would invent facts and is disallowed.
Offer an explicit user-reviewed grouping/import instead, retaining source
references and uncertainty. Preserve unbound legacy states. Upgrade/restore and
tenant/job deletion need exact-manifest/data/foreign-key tests under Storage's
existing migration protocol before any production implementation ships.

### Read models, counts and the boundary with #993

A future job-detail round timeline can compose the current schedule, its
revisions, participants, pinned preparation, actual occurrences and reflection
links. Separate “prepared questions” from “recorded questions asked.” Read
missing bindings and stale preparation honestly; do not conceal older accepted
content or substitute current catalog prose for remembered wording. Safe events
should carry only tenant/job/round/occurrence IDs, revisions, bounded lifecycle
codes and timestamps. Private wording, interviewer names, meeting links, source
notes and context snapshots stay in canonical local storage and permissioned
reads, outside SSE, telemetry and event-message text.

Counts can only describe bounded user-recorded observations: for example,
“you recorded this family in two of three completed rounds with question
records for these selected jobs.” State the date range, included jobs/rounds,
record completeness, confirmed versus possible matches, and unknown/unrecorded
rounds. Count occurrences and distinct rounds separately; exclude deleted
records and rejected matches. Missing records are not evidence the employer
did not ask a question. Do not label this employer-wide verified frequency,
probability, hiring advice or cross-user prevalence. An employer string does
not establish an employer identity or a defensible aggregation population.
No population-level frequency was measured here.

[Issue #993](https://github.com/ebarti/JobCtrl/issues/993) and the
[research packet](../research/interview-preparation/README.md) own editorial
question research, source reading, guidance, rubrics and future rehearsal/
validated grading. This round-history proposal consumes versioned cards only
as optional associations. It neither modifies the catalog nor designs a new
research corpus, scoring rubric, answer evaluator or practice-session system.
Rehearsal output must not become an actual occurrence. New user recollections
must not become accepted Profile facts without Profile's explicit review path.

Before future implementation, required proof includes independent revision
conflicts/rollback, tenant/job/round reference isolation, duplicate deliveries,
DST gaps/folds/date-only schedules, Contact edits/deletion, repeated/unmatched
questions and follow-ups, failed refresh link preservation, catalog retirement,
legacy migration, purge/retention behavior, and private-event exclusion. These
are design acceptance requirements, not executed future-feature tests or
current product guarantees.
