# Recruiting Intermediaries

JobCtrl records a posting source and a reported employer. It does not separately
record a publishing intermediary and its claimed client. The proposed extension is an optional, posting-specific relationship
observation. This page defines that future design; the relationship feature is
not implemented.

**Read this if** you need to distinguish recruiting agencies from hiring employers
without changing job identity, unknown facts or supervised action ownership.

## Current implementation

Current ownership is described against source revision
[`f734ef8bf1d27e3219b2122aed089421f61b7ca8`](https://github.com/ebarti/JobCtrl/tree/f734ef8bf1d27e3219b2122aed089421f61b7ca8).

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

### Existing ownership

Discovery keeps the reported company separate from the source board. Its exact
content identity rules do not establish an agency/client relationship, and the
scorer does not own a separate repost-equivalence decision. The Materials-owned
company briefing requires its own reviewed company identity. A posting-specific
relationship must preserve these boundaries rather than rewriting the company,
merging jobs or changing an eligibility decision.

## Synthetic boundary examples

The current identity functions have the following behavior for synthetic source
observations with distinct posting URLs and native IDs. These examples describe
existing boundaries, not the proposed relationship feature or semantic accuracy.

| Input | Existing behavior |
| --- | --- |
| Same normalized title/company/full text across distinct sources | First ingest: one new job. Second: zero new jobs, one observation and one duplicate link. Formatting-only normalization preserves fingerprint. |
| Same title/text with agency or different client company | Each creates one new job, zero duplicate links. No agency/client relationship is inferred. |
| Changed description, same title/company | One new job, zero duplicate links. Non-exact prose stays separate. |
| Empty/Unknown/manual-capture/Workday/LinkedIn company | Employer guard false for each; two distinct-source ingests create two jobs per label. `Synthetic Agency` passes the guard, which is label exclusion, not semantic verification. |
| Same posting under a second tenant | One new job in that tenant; owner IDs differ, no duplicate link. |
| Expanded enrichment followed by original listing | Real enrichment repository save, then listing ingest: zero new jobs, one observation, one fingerprint duplicate link to the original owner. Company and board remain separate. |

The examples use an in-memory schema. They do not establish runtime migration,
browser capture, end-to-end workflow recovery or provider accuracy.

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

### Implementation boundary

Implementation requires typed observations and persistence, evidence and
confirmation revision checks, additive contracts and ID-based read projections,
supervised job-detail review, privacy/retention and failure/race coverage.
Organization resolution, legal-employer verification, opportunity grouping and
market-wide agency research remain separate work. Validate the future acceptance
matrix through the actual writer, persistence layer and passive readers before
claiming the relationship capability is available.
