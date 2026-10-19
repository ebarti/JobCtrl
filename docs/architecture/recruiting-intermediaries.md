# Recruiting Intermediaries

JobCtrl records a posting source and a reported employer. It does not separately
record a publishing intermediary and its claimed client. This investigation for
[issue #953](https://github.com/ebarti/JobCtrl/issues/953) defines the smallest
compatible future seam: an optional, posting-specific relationship observation.
It delivers design, not a shipped relationship feature.

**Read this if** you need to distinguish recruiting agencies from hiring employers
without changing job identity, unknown facts or supervised action ownership.

## Current implementation

Inspected source: `f734ef8bf1d27e3219b2122aed089421f61b7ca8`, on
2026-10-19. Source inspection establishes ownership; the executions below have
separate, narrower limits. This delivery changes only this page and its three
navigation entries. Production code, schemas, budgets and runtime behavior stay
unchanged.

### Entry points and downstream owners

All source links in this section pin the inspected revision.

| Boundary / owner | Current responsibility and limit |
| --- | --- |
| [ATS adapters](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/src/jobctrl/infrastructure/discovery/ats_adapters.py), [JobSpy storage](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/src/jobctrl/discovery/jobspy.py), [manual capture wiring](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/src/jobctrl/infrastructure/discovery/production_wiring.py) | Adapters carry source-reported or explicitly configured company facts separately from the board. `_manual_capture_posting` uses extracted employer or `Employer.unknown()` with board `User-mediated capture`. Source/domain alone does not verify who employs the applicant. |
| [ScrapedJobPosting](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/src/jobctrl/domain/ports/discovery.py), [Source / Employer](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/src/jobctrl/domain/discovery/value_objects.py) | Posting handoff includes employer, board, metadata, source ID/native ID, canonical URL and ATS kind. It has no separate publishing-intermediary, claimed-client or relationship-confirmation fields. `Employer.unknown()` is `Unknown`. |
| [DiscoverJobsUseCase](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/src/jobctrl/domain/discovery/use_cases.py), [Job](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/src/jobctrl/domain/discovery/aggregate.py) | Discovery owns `(TenantId, JobId)`, source observations and duplicate links. Canonical/native/observation ownership is checked before guarded content matching. A duplicate decision is not evidence of representation. Posting URLs remain locators. |
| [SqliteJobRepository](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/src/jobctrl/infrastructure/discovery/sqlite_repository.py), [identity resolver](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/src/jobctrl/infrastructure/discovery/sqlite_identity_resolver.py) | `company` is separate from `site`; absent company hydrates as Unknown. `find_content_owner` filters by tenant and normalized title/company, guards both employer labels and checks listing plus enriched descriptions. Locator lookup resolves canonical IDs; it does not resolve organizations. |
| [Content identity](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/src/jobctrl/domain/job_content_identity.py) | Exact full-content fingerprint over normalized title, company and description. Formatting normalization is mechanical. `content_match_basis` returns only `fingerprint` or no match. `is_genuine_employer_identity` excludes finite sentinel/platform labels; despite its name it does not verify a hiring employer and accepts `Synthetic Agency`. |
| [Enrichment extraction](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/src/jobctrl/domain/enrichment/services.py), [repository](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/src/jobctrl/infrastructure/enrichment/sqlite_repository.py) | `ExtractionResult` contains success, full description and best-effort application URL, not relationship roles. `job_enrichments` owns enriched description/application URL per tenant/JobId. Preserve [application URL authority](application-url-authority.md). |
| [Manual provenance](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/src/jobctrl/domain/discovery/source_registry.py), [posting snapshots](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/src/jobctrl/domain/enrichment/snapshot_value_objects.py) | Capture provenance retains origin/time/mode/tool; `capture_client` means the capture tool, not a hiring client. A `PostingContentSnapshot` records source, description hash, apply URL, extraction tier, time and evidence strings, not a full-description field. Hashes alone cannot ground a quoted relationship. |
| [JD snapshot](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/src/jobctrl/domain/job_snapshot.py), [AnalyzeJobUseCase](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/src/jobctrl/domain/materials/analyze_use_case.py) | Current snapshot includes title, company, location, salary, remote and full description (listing fallback). Analysis is source-grounded and versioned, with claim-verification and job-interpretation determination IDs before save. Its name does not establish legal employer identity. |
| [Scorer](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/src/jobctrl/scoring/scorer.py) | Same-content score reuse includes company and the full enriched description, with criteria/profile version checks. `_persist_reused_score` writes to the destination JobId; it neither merges jobs nor records a client. Repost title/location inference is removed. |
| [Determination contract](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/src/jobctrl/domain/determinations.py), [SQLite determination owner](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/src/jobctrl/infrastructure/determinations.py) | Strict schema/citation validation, fingerprinted source/context/version identity, persisted provider/model provenance, lane and spend preflight, cached reuse and distinct structural/provider failures provide the existing semantic seam. There is no relationship-specific determination here. |
| [Company briefings](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/src/jobctrl/infrastructure/materials/company_briefings.py) | Explicit company-link confirmation and public-source configuration are independent authorities. Configuration revisions fence refresh acceptance; failed refreshes preserve accepted briefings. A client claim must not silently replace this confirmed identity. |
| [Contact aggregate](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/src/jobctrl/domain/contact/aggregate.py), [fact provenance](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/src/jobctrl/domain/contact/value_objects.py), [research policy](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/src/jobctrl/domain/contact/source_policy.py) | Contact links employer and/or JobId and can have recruiter role. Each attribute requires provenance. Public-page research requires opt-in, protected sources route to manual capture and private/local targets are rejected. Membership, email domain and employer strings confer no agency mandate. |
| [Python projection builder](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/src/jobctrl/infrastructure/projections/projection_builder.py), [TypeScript projection builder](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/apps/api/src/projections.ts) | Contact projections qualify tenant and carry links, counts and provenance without attribute values. Readers must join recorded IDs rather than rediscover relationships from names. |
| [Contacts API](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/apps/api/src/contacts.ts), [job read model](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/apps/api/src/read-model.ts) | Job reads compose existing canonical/projection owners; there is no relationship projection contract. Contact detail reads canonical attribute values with provenance; value-free projections do not imply value-free API responses. API contact reads use the local tenant constant. |
| [Outreach API](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/apps/api/src/outreach.ts), [draft gates](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/src/jobctrl/domain/contact/outreach_gates.py) | Approval requires a candidate draft and persisted passing gates. Rejection preserves the approved draft. `logOutreachSend` records a user assertion over an approved draft; it opens no transport. |
| [Application review](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/apps/api/src/application-feedback.ts), [Apply gates](../user/apply.md) | Approval binds materials generation, profile version and current application target, with existing dry-run/override requirements. Relationship acceptance is no submission authority. |

### Reconciliation with earlier work

Local Git contains two earlier design revisions:
[`b47b3a1b2`](https://github.com/ebarti/JobCtrl/commit/b47b3a1b2792dc4ceb252fce6573bc0f715b3a0b)
and `d946a336c` (full IDs and complete page bytes retained with the investigation).
They inspected baseline `67b4175aa2d9e8f96e62da545886b1e8712bf691` and later
reported a reproduction at `b47b3a1b2`. Their ownership, missing relationship
contract, additive design and action/privacy separation remain useful. Their
measurements do not validate this revision.

[PR #212](https://github.com/ebarti/JobCtrl/pull/212), represented locally by
`449685d6b93b318b21274408390183386ccce556`, added shared cross-source content
matching. Its actual diff uses the former `jobhunter` package paths, includes a
Smart Extract content-dedup hook (still using direct SQL) and allowed a guarded
company/site fallback and shingle matching. Its commit narrative says Smart Extract was excluded; the diff is the
stronger evidence for what that revision changed. Neither that fallback nor
shingle semantics describes the inspected current repository.

[PR #1064](https://github.com/ebarti/JobCtrl/pull/1064), represented by
`0b61aef78` (full commit retained), removes shingle matching, reference-repost
selection/title-location helpers and the scorer's 6,000-character fingerprint
cap. Consequently the earlier AST repost predicate, rewritten-description reuse
results and associated proposed scorer repair are **superseded history**. Do not
reproduce removed functions or treat score reuse as representation evidence.
Some source docstrings still mention shingles; executable current owners above
and the current tests determine this investigation's claims.

The earlier page reports 76 Python passes, 163 script passes, an emitted-HTML
probe and a passing review, but also an **overall failed historical QA**. Its
narrative describes browser captures whose original images, viewport records,
transcripts and receipts are unavailable in this handoff. The retained Git pages
are inspected historical reports, not independent verification of those results
or approval of this candidate. Git commit messages are available; live issue/PR
metadata, linked reviews, CI, tracking and current open/merged states were not
read from GitHub by the author. The controller owns those readbacks.

What remains missing is a structured posting-specific publisher/client claim,
disclosure state, evidence binding and versioned user decision. No reproduced
current gap justifies a production dedup/scoring repair within this design item.

## Synthetic evidence

### Reproduction and provenance

Author measurements use owned synthetic inputs, in-memory SQLite and current
imported functions/use cases, with no AST extraction, real workspace, provider,
external fetch, research send or application. These measure **current boundaries**,
not the proposed relationship feature or its semantic accuracy.

Retained evidence is in the controller-authorized handoff location
`role-artifacts/authoring/implement/25eb12a9ceecabc9ca49146e818d5bef76db571e52222dfa04949f3f8c057998/`.
It contains `run.py`, `identity_probe.py`, `identity-inputs.json`, complete
stdout/stderr, per-command receipts (argv/cwd/UTC start/finish), JUnit,
`source-manifest.json`, historical source diffs and `SHA256SUMS`.
The controller allocation resolves that relative location to the retained run,
not a temporary host directory. The evidence manifest binds final document bytes
separately from the unchanged source tested here; resume must verify both.

Input candidate is
`043e270a4ede87afa9a3e5bd8f776f1e71c777096bc981a425774ec46ed4aed2`,
HEAD/base `f734ef8bf1d27e3219b2122aed089421f61b7ca8`, original content digest
`1fea51253aca69612b02a1cbe42eb555fce830ceec649dbe6727c012ec375a8d`.
The copied `input-receipts.json` hash is
`b10698c8f29a87711680312616835a87d498a2cc8a4050dc7bbff52c58cef7cd`.
Its preparation and baseline logs were read in full and hash-checked; they are
broker dependency/native-load evidence, not the author's test results.

From repository root, set `evidence_dir` to that allocated directory and run:

```bash
workers/automation/.venv/bin/python "$evidence_dir/run.py" probe
workers/automation/.venv/bin/python "$evidence_dir/run.py" tests
workers/automation/.venv/bin/python "$evidence_dir/run.py" diff
```

The runner uses the prepared project Python (CPython 3.12.13), and for Node tests
the receipt's absolute Corepack/Node 22.21.1 paths and exact recorded PATH,
COREPACK_HOME and npm_config_nodedir environment. It performs no installation.
The API command is `corepack pnpm --filter @jobctrl/api exec vitest run
test/contact-projection-parity.test.ts` with default and JUnit reporters.
Python invokes the seven files below with `-q -o pythonpath=src` and an owned
`--junitxml` path. Commands and times in receipts are actual measurements, not
proposed execution times.

### Observed current boundaries

`identity_probe.py` imports `DiscoverJobsUseCase`, `SqliteJobRepository`, the exact
v14 schema creator and the enrichment aggregate/repository. Source observations
use distinct `.example` URLs/native IDs so canonical precedence cannot mask the
content boundary. The fixture fixes IDs, clock and text; full inputs and output
are retained. Current results, exit 0:

| Probe | Actual result |
| --- | --- |
| Same normalized title/company/full text across distinct sources | First ingest: one new job. Second: zero new jobs, one observation and one duplicate link. Formatting-only normalization preserves fingerprint. |
| Same title/text with agency or different client company | Each creates one new job, zero duplicate links. No agency/client relationship is inferred. |
| Changed description, same title/company | One new job, zero duplicate links. Non-exact prose stays separate. |
| Empty/Unknown/manual-capture/Workday/LinkedIn company | Employer guard false for each; two distinct-source ingests create two jobs per label. `Synthetic Agency` passes the guard, which is label exclusion, not semantic verification. |
| Same posting under a second tenant | One new job in that tenant; owner IDs differ, no duplicate link. |
| Expanded enrichment followed by original listing | Real enrichment repository save, then listing ingest: zero new jobs, one observation, one fingerprint duplicate link to the original owner. Company and board remain separate. |

The first probe attempt failed while seeding an incomplete synthetic enrichment
SQL row (`NOT NULL ... current_status`). Its code/output are retained as
`identity_probe_attempt_1.py` / `identity-probe-attempt-1.*`. The corrected probe
uses the actual enrichment aggregate and repository and passes. That fixture
error is not a product defect. The exact-v14 in-memory schema is not a stopped
runtime admission/migration, browser capture or end-to-end workflow test.

### Focused executed checks

| Existing test owner | Executed / skipped | Scope of measured proof |
| --- | --- | --- |
| [test_discovery_identity.py](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/tests/test_discovery_identity.py) | 28 / 0 | Current exact/content ownership, source attribution, distinct employers, unknown labels and listing/enriched boundaries. |
| [test_scorer.py](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/tests/test_scorer.py) | 25 / 0 | Reported company in prompts, exact-content reuse and analysis-refresh failures; no removed repost selector. |
| [test_contact_provenance.py](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/tests/test_contact_provenance.py) | 4 / 0 | Required provenance structure. |
| [test_contact_research_source_policy.py](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/tests/test_contact_research_source_policy.py) | 10 / 0 | Default denial, public opt-in, protected/manual and private-source policy. No live fetch. |
| [test_contact_projection_parity.py](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/tests/test_contact_projection_parity.py) | 1 / 0 | Shared two-tenant fixture and sensitive-value exclusion in the historical exact-v7 schema. |
| [test_semantic_determinations.py](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/tests/test_semantic_determinations.py) | 33 / 0 | Opposite valid model decisions on identical inputs, strict citations/schema, lane/preflight, cache, concurrent reuse and distinct failures without fallback. Synthetic model doubles, not live provider accuracy. |
| [test_company_briefings.py](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/workers/automation/tests/test_company_briefings.py) | 34 / 0 | Independent company identity, opt-in/public-source bounds, changed-employer review, configuration race, atomic failure preservation and concurrent reuse. Synthetic sources/doubles. |
| API [contact-projection-parity.test.ts](https://github.com/ebarti/JobCtrl/blob/f734ef8bf1d27e3219b2122aed089421f61b7ca8/apps/api/test/contact-projection-parity.test.ts) | 3 / 0 | Package-owned projection parity, tenant scoping and value exclusion. |

Author totals: **135 Python passes** in 7.94s and **3 API passes**, zero failures,
errors or skips. Separate `focused-python.xml` and `contact-api.xml` retain case
identities. The shared contact fixture originated with exact-v7 parity: Python
still constructs exact v7 while the API's `initializeExactDatabase` uses its
current schema helper. Success does not prove current cross-runtime migration,
real data admission, new relationship projections or authorization behavior.

## Future architecture, not implemented

### Minimal compatible observation

Discovery should own an additive observation scoped to `(TenantId, JobId)` and
existing source-observation/snapshot anchors. Enrichment may propose extracted
claims; it must not rewrite Discovery's reported employer. This is a design seam,
not a new organization directory, schema migration or endpoint in this delivery.

| Role | Proposed meaning |
| --- | --- |
| Posting source | Existing registry ID, board, native ID and locator remain acquisition facts. A platform hosting an agency advert is still only its source. |
| Publishing intermediary | Optional source-asserted organization acting in recruitment for this posting; multiple observations allowed. A label/domain does not establish this role. |
| Reported employer | Preserve existing `Employer.name` / `jobs.company` exactly as the current reported fact, including Unknown. It may name an agency, staffing firm or employer. |
| Claimed client / hiring employer | Optional identity plus a cited role claim. Distinguish the organization employing the worker from a client/work site; neither role implies the other. A staffing firm can publish and employ without a client claim. |
| Recruiter contact | Optional independently accepted same-tenant ContactId. Contact owns personal values/provenance. Recruiter role or membership alone is no relationship evidence. |

Each observation needs an immutable ID, tenant/JobId, asserted role/participants,
source observation and evidence revision IDs, capture time/method, retained
supporting text/reference and any extraction determination ID. Unknown identity
stays null. Disclosure is separately `disclosed`, explicitly `undisclosed`, or
`not_stated`; failure to capture/extract must not become “confidential client”.
Do not fill gaps from names, domains, titles, location similarity, score reuse,
recruiter membership or inferred corporate affiliation.

Provenance must locate exact retained text, not only its hash. Preserve manual
capture origin/tool metadata. Explicit user assertions carry their own canonical
source ID and provenance; they do not impersonate source disclosure. Evidence
unavailable after capture means unsupported/unknown until recaptured, never an
invented quote. A source's claim of representation is still a claim, including
claims of exclusivity or legal employer status.

### Semantic extraction and failure authority

Use the existing determination infrastructure rather than lexical detection.
The future strict schema must enumerate roles, disclosure and claim status,
allow null/unknown facts, reject extra fields/foreign participant or source IDs,
and require verbatim citations for every extracted claim. Supply canonical source
IDs/text; persist kind, schema/prompt versions, provider/model, lane, input
fingerprint and result before admitting a candidate observation. Readers join
those recorded IDs. Citation validation proves text binding, not truth or a legal
mandate. A model's confidence cannot confirm a relationship.

Wire extraction to the existing enrichment lane and its spend preflight before
each new call; do not add a lane, budget or autonomous research task. Identical
source/context/configuration versions reuse persisted, validated determinations
without a call; changed source, model, schema or prompt versions require a new
candidate. Keep provider unavailable/error, budget denial, malformed JSON,
schema/enum violations, foreign IDs, non-verbatim quotes, exact-value mismatch,
stale evidence and persistence failures distinct. No regex, vocabulary list,
token overlap or hand-tuned prose threshold decides meaning or supplies fallback.
Mechanical parsing and exact user-authored filters retain their existing scope.

Future proof must drive the real owner with the same canonical inputs and two
different valid model decisions, showing the verdict controls proposed claims.
Exercise each failure and cache/preflight boundary in an owned synthetic
workspace, with no eval corpus, labeled dataset or recorded-output replay fixture.
The current generic determination tests support this seam; they do not execute
this unimplemented relationship schema or confirmation flow.

### Confirmation, conflicts and refresh

Claim status is independent of disclosure: `unknown`, `proposed`, `confirmed`,
`conflicting`, with retained rejection/supersession history. Source/model claims
start proposed. Confirmation records deliberate user acceptance of precise
participants, roles, claim and evidence version; it does not independently verify
legal, exclusive or current representation. An accepted undisclosed-client claim
still has null client identity.

Multiple intermediaries or roles need not conflict. Incompatible claims for the
same asserted relationship remain separate and conflicting until explicit review;
newest capture, confidence, domain or score cannot choose a winner. Retain the
rejected alternatives and the decision's source IDs.

Refresh creates a candidate; it never edits the accepted observation in place.
Atomically compare expected accepted revision and evidence fingerprint on
confirmation/replacement. Reject stale confirmations after either an evidence
change or another acceptance; simultaneous reviewers cannot silently overwrite
each other. A concurrent failed refresh must not roll back a newer acceptance.
Capture/model/validation/storage failure preserves the last accepted relationship,
analysis, briefing and materials bytes; record safe attempt/failure metadata
separately. Restart/retry must read accepted IDs and versions and use idempotent
commands; it cannot re-confirm or repeat an external action.

### Compatibility, privacy and action ownership

Qualify reads, writes, references, projection joins and decisions by tenant and
JobId. Reject another tenant's job, evidence or contact, and same-tenant evidence
from an unrelated job. Do not correlate organization labels globally. A contact
reference must satisfy the existing contact link rules and deliberate association;
it cannot implicitly reuse another job's private notes or claims.

Preserve existing reported employer, canonical JobIds, source observations,
locators, application targets, eligibility and scoring policy, accepted artifact
generations and profile/materials/target approval bindings. Relationship
confirmation cannot merge jobs, retarget applications, change eligibility,
approve outreach, create a send log, authorize submission or start research.
Company-briefing identity stays independently confirmed; client claims cannot
reconfigure it. Future scoring/materials consumption would need its own reviewed
authority and grounding contract; claims must not become applicant facts or
uncited generated prose.

Keep personal contact values and sensitive supporting spans in restricted
canonical evidence. Project safe organization/status metadata and opaque IDs,
not names/emails/phones/private notes from Contact attributes. API detail access
must respect those owners; events, telemetry, logs and public exports must omit
sensitive spans, URL tokens and contact values. Public references remain inert
evidence, never instructions to fetch, bypass access controls or communicate.
A future implementation must cover retention/purge and recoverability of its
owned graph without deleting accepted artifacts through a failed refresh. No
real workspace or destructive operation is needed for this investigation.

### Future acceptance matrix

These are implementation requirements, **not executed feature scenarios**.

| Scenario / trigger | Required future observation and preserved boundary |
| --- | --- |
| Direct employer posting | Source/company/JobId/target unchanged; publisher and hiring employer may coincide. No intermediary fabricated. |
| Agency discloses client | Retain publisher and verbatim client-role claim separately, initially proposed; explicit version-bound acceptance. No company rewrite. |
| Agency explicitly withholds client | Disclosure `undisclosed`, client null, cited withholding statement. Acceptance does not reveal or infer identity. |
| Client not mentioned / capture missing | `not_stated` / unknown with acquisition failure separate. No confidential-client claim synthesized. |
| Staffing firm hires worker for client site | Firm can be publisher and employer; optional work-site client remains a distinct role. Do not replace employer. |
| Multiple intermediaries on one posting / similar postings | Preserve separate claims/sources. Relationship never merges jobs; existing identity rules remain independently authoritative. |
| Conflicting client or employer claims | Retain competing versions, surface conflict, require explicit resolution retaining history. No confidence/latest-wins rule. |
| Same role/city, rewritten text, equal scores or recruiter membership | No relationship/equivalence inference or eligibility change; all unknowns stay unknown. |
| Unknown employer / platform fallback | Preserve current sentinel guard and reported fact; no client guessed from board/domain. |
| Cross-tenant job/contact/evidence reference | Reject before persistence; tenant-filtered readback leaks no values. Matching labels confer no authority. |
| Same tenant, foreign JobId evidence / unintended contact association | Reject mismatched posting anchors and require deliberate eligible contact association. No cross-job evidence reuse by similarity. |
| Stale evidence confirmation / concurrent reviewers | Compare evidence and accepted revision atomically; only one matching acceptance succeeds. Stale client re-read and retry is explicit. |
| Failed or concurrent refresh, restart/retry | Last accepted relationship and artifacts survive; safe failure history, idempotent commands and version-fenced readback. No automatic re-confirmation. |
| Model authority, cache and structural failures | Opposite valid decisions control proposals; unchanged cache makes zero calls; preflight precedes new calls; every named failure has no lexical fallback. |
| Privacy, public-source and action boundaries | No private values in projections/events/telemetry; no research, communication, send log, approval or submission from relationship acceptance. |
| Confirmed company briefing and existing application approval | Preserve both independently confirmed identity and approval's original generation/profile/target binding. |

### Validation and delivery handoff

The production-feature work still needed is typed observations and persistence,
evidence/confirmation revision fences, additive contracts and ID-based read
projections, supervised job-detail review, privacy/retention and failure/race
proof. Organization resolution, legal-employer verification, opportunity grouping
and market-wide agency research are deferred. Do not expand this design delivery
into that feature or create decomposition/sub-issues from this run.

For this four-file design candidate, the controller's validation protocol is:

1. Bind the implementation checkpoint, retained source/lock hashes, exact commands,
   full outputs and JUnit to candidate identities. Preserve actual UTC runtime
   start/finish records; carry valid unchanged evidence forward without treating
   historical candidates as final-head approval.
2. Run `scripts/checks.toml` recipes `checks.scripts` (owned JUnit replacing
   `{report_path}`), `checks.docs` and `checks.diff`, plus uncommitted
   `git diff --check`. Dependency preparation remains controller-owned.
3. After the docs build run `corepack pnpm docs:check:runtime`, then direct-page
   browser QA for `/architecture/recruiting-intermediaries`, absent from that
   script's configured page list. Use a fresh owned preview and ephemeral browser,
   block outbound traffic, inspect desktop/mobile navigation, all three required
   headings, issue link, wide tables/code containment, hydration and assets.
   Retain actual viewport sizes, screenshots/hashes, errors and runtime receipts
   with candidate IDs. Emitted HTML alone is not browser proof.
4. Independent review and QA assess source/history/proposal separation, semantic
   authority, unknown facts, compatibility and privacy. Continue independent
   checks after a failure, batch findings and mark dependent checks unverified.
   Repair all findings within scope and recheck original triggers and affected
   later boundaries. No unresolved Blocker/High may remain.
5. The controller creates/validates the author-signed Conventional Commit and
   publishes one investigation PR referencing #953 without a shipped-feature
   closeout. Preserve permitted early publication and concurrent review/CI; do
   not merge. Require applicable final-head Docs Site, Repo Scripts, Release
   Privacy Gate and DCO disposition, live issue/linked-PR and final
   PR/issue/tracker/assignee readbacks.
6. On resume/settlement verify candidate/evidence hashes, final open/unmerged PR
   and issue state, retained reports/screenshots/receipts and ownership before
   cleaning only owned resources. No missing historical approval may be promoted
   to current approval; no statistics reset, other run, release or deployment
   belongs to this delivery.

This protocol specifies evidence required at later stages. The author executions
above establish the current bounded measurements; they do not establish those
later gate outcomes or that a recruiting-intermediary feature is implemented.
