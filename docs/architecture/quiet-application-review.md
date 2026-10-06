# Quiet Application Outcome Review

Quiet means **no reviewed response within a disclosed observation period**. It
does not mean rejection, verified inbox completeness, or evidence that a
tailoring policy worked or failed. This investigation separates the existing
feedback and reminder mechanisms from a proposed local review capability.

**Read this if** you need to distinguish recorded application feedback from a
future bounded assessment of applications with no reviewed response.

**Owning issue:** [#1035](https://github.com/ebarti/JobCtrl/issues/1035).
**Status:** future architecture, not implemented; includes bounded synthetic
measurements of the current Python and TypeScript implementations. This is not
live-provider or deployed-runtime verification.

The implementation inspected here is commit
`1ecb877dbb5275afeabfa6ca1ae872f88dbaaacb`, tree
`86ce2d6afd8d4b76a6fd2f36409a22d941df2527`. The accepted scope adds only this
document. It introduces no runtime feature, schema, endpoint, scheduler,
classifier change, or navigation change. Existing product behavior remains owned
by [Apply Feedback & Projections](read-model.md).

<a id="current-implementation"></a>

## Current Implementation

These are inspected source facts. Links pin the owning source and tests to the
inspected commit; the separate [synthetic evidence](#synthetic-evidence) section
identifies what executed, its seams and its limits. Inspected assertions alone
do not establish runtime behavior.

### Reviewed outcomes and pending suggestions

The shared
[outcome contract](https://github.com/ebarti/JobCtrl/blob/1ecb877dbb5275afeabfa6ca1ae872f88dbaaacb/packages/contracts/src/schemas.ts#L1354)
includes `no_response` and `unknown`, alongside confirmation, recruiter reply,
interview, assessment, rejection, offer, withdrawal and bounce. In
[application-feedback.ts](https://github.com/ebarti/JobCtrl/blob/1ecb877dbb5275afeabfa6ca1ae872f88dbaaacb/apps/api/src/application-feedback.ts#L459),
`recordManualApplicationOutcome` resolves the job locator to a canonical job ID
and records a manual outcome. A user can record `no_response`; this path does
not establish inbox coverage or an employer decision.

`decideOutcomeSuggestion` records an outcome for acceptance or correction of a
pending suggestion, links it to the evidence and suggestion IDs, and marks the
suggestion accepted or corrected. Ignoring marks it ignored without creating an
outcome. An already-decided suggestion returns its existing decision rather
than creating another outcome. Unless the caller supplies `occurredAt`, the
suggestion decision uses decision time, not the message's receipt time. Response
timing can therefore reflect review timing rather than employer timing.

Private notes remain in canonical outcome rows. The outcome and decision events
carry references, controlled values and presence flags, not note or reason text.
The inspected
[API feedback tests](https://github.com/ebarti/JobCtrl/blob/1ecb877dbb5275afeabfa6ca1ae872f88dbaaacb/apps/api/test/application-feedback.test.ts#L1791)
cover manual writes, safe scan responses, invalid timestamps, private payload
exclusion and repeated suggestion acceptance. The
[identity tests](https://github.com/ebarti/JobCtrl/blob/1ecb877dbb5275afeabfa6ca1ae872f88dbaaacb/apps/api/test/application-feedback-v7.test.ts)
inspect tenant isolation for shared job IDs. Neither source inspection nor
in-process API fixtures establish deployed-runtime compliance.

### Bounded Gmail feedback ingestion

The
[scanner](https://github.com/ebarti/JobCtrl/blob/1ecb877dbb5275afeabfa6ca1ae872f88dbaaacb/workers/automation/src/jobctrl/infrastructure/gmail/feedback.py#L124)
requires an exact-v12 database and a recipient address. Its defaults are 25
anchors, five results per anchor and a 45-day window. Arguments are clamped to
1–100 anchors, 1–20 results per anchor and 1–180 days. These are configuration
bounds, not measured coverage, latency or reliability guarantees.

The
[anchor readers](https://github.com/ebarti/JobCtrl/blob/1ecb877dbb5275afeabfa6ca1ae872f88dbaaacb/workers/automation/src/jobctrl/infrastructure/gmail/feedback.py#L564)
join jobs, enrichment, outcomes and apply-run projections by tenant and job ID.
They use `job_enrichments.application_url`, not a historical application-locator
alias. Without enrichment, that application URL is empty; employer, title and
posting URL hints may remain. Anchor sources are:

| Source | Existing selection and clock |
| --- | --- |
| Job row | Nonempty `applied_at`, or case-insensitive `apply_status = applied`; use `applied_at`, falling back to `discovered_at`. |
| Reviewed outcome | Confirmation, recruiter reply, interview, assessment, rejection, offer or bounce; use `occurred_at`. `no_response`, withdrawal and unknown do not supply this anchor. |
| Apply-run projection | Non-dry-run success-like status, or a result containing `applied` or `submitted`; use `finished_at`, falling back to `started_at`. |

For each job, the loader keeps the earliest eligible clock across those
sources, then selects the newest of those per-job clocks up to the requested
limit. Discovery time and result-text fallbacks are not independently verified
submission evidence. An old application may be outside the selected cohort, and
the window is anchored to that stored clock rather than to the scan time.

The
[Gmail client](https://github.com/ebarti/JobCtrl/blob/1ecb877dbb5275afeabfa6ca1ae872f88dbaaacb/workers/automation/src/jobctrl/infrastructure/gmail/client.py#L124)
builds a recipient, hint and date query, requests one bounded message listing,
then reads metadata. It filters returned `internalDate` against the precise
requested timestamps. It does not traverse listing continuation pages in this
method. The query dates have calendar-day granularity. No execution here proves
Gmail's external search semantics, coverage across folders or aliases, or account
completeness. An empty returned list means only that this search returned no
candidates.

The
[metadata linker](https://github.com/ebarti/JobCtrl/blob/1ecb877dbb5275afeabfa6ca1ae872f88dbaaacb/workers/automation/src/jobctrl/infrastructure/gmail/feedback.py#L508)
adds fixed weights for recipient (0.2), time window (0.2), company (0.2), title
(0.15), application domain (0.15), applicant-tracking-system hint (0.1) and outcome
term (0.1). It rounds and caps the score at 1, and links at 0.7. Only subject,
sender and recipient text contribute to lexical matching; the snippet does not
authorize a body read. These scores are deterministic rule weights, not
calibrated probabilities. Recipient and time are weighted signals rather than
mandatory linker predicates; the normal client's filtering is a separate seam.

Only linked metadata triggers `read_email`. The
[classifier](https://github.com/ebarti/JobCtrl/blob/1ecb877dbb5275afeabfa6ca1ae872f88dbaaacb/workers/automation/src/jobctrl/infrastructure/gmail/feedback.py#L301)
uses the first substring rule matching the concatenated subject, snippet and
body. Precedence is bounce, offer, rejection, interview, assessment,
confirmation, recruiter reply, then unknown (confidence 0.25). Broad terms such
as `congratulations`, `unfortunately` and `availability` lack contextual,
quotation and negation handling. Ambiguous language needs user review; the
confidence constants do not establish classification accuracy. Unknown means
the linked message matched no classification rule, not that the employer
rejected the application or that no message arrived.

The scanner stores linked evidence and a pending suggestion, including for
unknown classification. It does not insert a reviewed outcome or derive
`no_response` from quietness. Stored body text is limited to 12,000 characters,
and its stored hash covers that retained text. Classification uses the body
before that storage truncation; a classification can therefore depend on text
outside the retained excerpt. The synthetic evidence below reproduces that
boundary.

Within a tenant, an already-stored provider message is skipped before the body
read, with a second duplicate check inside the write transaction. Evidence,
suggestion and safe ingestion event commit together; notifications publish
after commit. A message linked to an earlier anchor is not independently
reassigned to every matching application. The scan response contains reference
and confidence fields, not bodies. Raw mail and contact metadata stay in the
local evidence row; ingestion events contain IDs, provider, kind, confidence and
link signals. The scan response does not attest exhaustive review coverage.

Inspected worker regressions include
[linking, duplicate/race and safe-event cases](https://github.com/ebarti/JobCtrl/blob/1ecb877dbb5275afeabfa6ca1ae872f88dbaaacb/workers/automation/tests/test_gmail_feedback.py),
[canonical URL and tenant anchor cases](https://github.com/ebarti/JobCtrl/blob/1ecb877dbb5275afeabfa6ca1ae872f88dbaaacb/workers/automation/tests/test_gmail_feedback_v10_anchors.py),
and [scan-handler parameter/error mapping](https://github.com/ebarti/JobCtrl/blob/1ecb877dbb5275afeabfa6ca1ae872f88dbaaacb/workers/automation/tests/test_gmail_feedback_scan_handler.py).
The anchor test module retains its historical exact-v10 fixture. Gmail clients,
handler scan calls and worker dispatch in these tests use explicit doubles;
they do not exercise an authenticated Gmail account.

### Analytics describe recorded history

Both production projection builders—
[TypeScript](https://github.com/ebarti/JobCtrl/blob/1ecb877dbb5275afeabfa6ca1ae872f88dbaaacb/apps/api/src/projections.ts#L3413)
and [Python](https://github.com/ebarti/JobCtrl/blob/1ecb877dbb5275afeabfa6ca1ae872f88dbaaacb/workers/automation/src/jobctrl/infrastructure/projections/projection_builder.py#L3227)—
count applied jobs using their applied timestamp/status predicate in the active
cohort. Those clocks/statuses come from the job-list projection: the Python
[job projection](https://github.com/ebarti/JobCtrl/blob/1ecb877dbb5275afeabfa6ca1ae872f88dbaaacb/workers/automation/src/jobctrl/infrastructure/projections/projection_builder.py#L1524)
uses a succeeded apply run or an explicit manual-mark event/confirmation outcome,
rather than treating a legacy job timestamp alone as projection authority.
Canonical outcomes, not pending suggestions or mail bodies, determine
reply/interview/offer/rejection counts. A reply is a recruiter reply, interview,
assessment, offer or rejection; interview includes assessment and offer.
Confirmation-only, missing outcomes, `no_response` and unknown do not increment
reply. None of those absences becomes a rejection count.

Response time uses the earliest valid reply-kind `occurred_at` at or after a
valid `applied_at`, floored to minutes. Missing/invalid application clocks and
pre-application replies supply no response-time sample. A reply count can exist
without a usable response-time sample. Quiet applications do not contribute
elapsed waiting time to the response-time list; this is a responded-only sample,
not a survival analysis of all applications.

The
[read model](https://github.com/ebarti/JobCtrl/blob/1ecb877dbb5275afeabfa6ca1ae872f88dbaaacb/apps/api/src/read-model.ts#L4213)
keeps raw counts visible while suppressing rates below five applied samples,
response-time medians below five response samples, and suggestion acceptance
rates below five decided suggestions. Accepted/corrected/ignored counts describe
user decisions, not independent classification ground truth. Grouping by source,
score/fit band, application mode, template or tailoring policy establishes no
causal policy-effectiveness claim. Different observation periods, selection and
missing reviews can all affect those counts.

The inspected
[dashboard projection regressions](https://github.com/ebarti/JobCtrl/blob/1ecb877dbb5275afeabfa6ca1ae872f88dbaaacb/workers/automation/tests/test_dashboard_projection.py#L751)
cover recorded conversion counts, material/policy grouping, response minutes,
suggestion decisions and small samples. The
[API projection tests](https://github.com/ebarti/JobCtrl/blob/1ecb877dbb5275afeabfa6ca1ae872f88dbaaacb/apps/api/test/projections.test.ts)
exercise local projections/read paths with synthetic storage and mocked runtime
seams. They do not prove mail completeness or policy effectiveness.

### Reminders remain user-owned

The
[outreach derivation](https://github.com/ebarti/JobCtrl/blob/1ecb877dbb5275afeabfa6ca1ae872f88dbaaacb/workers/automation/src/jobctrl/domain/contact/outreach.py#L266)
suggests a first follow-up seven calendar days after the supplied submission
clock, then a subsequent nudge fourteen days after the supplied last follow-up
due time. A logged reply or missing submission anchor suppresses the suggestion.
The derivation receives no current clock, so it cannot independently establish
that the previous follow-up elapsed or was sent. Due status is separate:
`follow_up_is_due` requires a scheduled state and compares `due_at <= now`.
Completed and dismissed schedules are not due.

These are editable, surfaced reminders; the outreach aggregate has no send
transport. Existing
[follow-up regressions](https://github.com/ebarti/JobCtrl/blob/1ecb877dbb5275afeabfa6ca1ae872f88dbaaacb/workers/automation/tests/test_outreach_follow_up_derivation.py)
inspect cadence, suppression, date boundaries and scheduling. A due reminder
neither records employer rejection nor authorizes a send or submission.

<a id="synthetic-evidence"></a>

## Synthetic Evidence

### Retained execution and provenance

These author-produced measurements ran on 2026-10-06 against the pinned source
above. Python probes used the preparation receipt's locked Python 3.12.13
interpreter, with normally imported repository source and dependencies from the
controller-prepared project environment. SQLite was 3.50.4, pytest 9.1.1 and uv
0.12.17 on macOS arm64. Node probes and API tests used the receipt's absolute
Node 22.21.1 and Corepack paths and exact recorded environment; pnpm was 10.24.0,
Vitest 4.1.11, tsx 4.22.4 and better-sqlite3 12.9.0. The wrapper verifies the
recorded Node, Corepack and native-binding hashes before execution. No real
account, send, submission or external-reference compliance was exercised.

The retained evidence allocation identifier, relative to the controller's
`role-artifacts` root, is:

```text
authoring/implement/d0467f571d91ff8189b51b3226df062f84b20ffb3d5f8f525bc7a0443fd50149
```

Artifact names below are relative to that allocation except explicitly
historical attempts. Absolute host locators remain in retained local metadata,
alongside unchanged original probes, inputs and outputs. `run_attempt_v3.py` is
the original deadline wrapper. Every attempt
directory retains complete original `stdout.txt`, `stderr.txt` and `receipt.json`, including
failed attempts; receipts contain exact argument arrays, working directory,
safe environment overrides, UTC start/end times, deadline, exit status, timeout
flag and output hashes. `artifact-manifest-v2.json` inventories retained files,
while `source-manifest-v2.json` hashes 635 imported/inspected source, schema,
test and package/lock files and records Git blob, commit/tree and input-candidate
identity. Every hashed repository source matched the pinned baseline bytes.
`imported-sources.json` in the successful probe workspace records 199 actual
Python module resolutions. `python-identity-01` and `tool-identity-02` retain
measured interpreter and tool versions. `summarize_v3.py` and `summary-03/stdout.txt` reproduce the
tabular extraction without replacing original outputs.

The copied controller handoff `receipts.json` was read and its supplied SHA-256
`53216d00f9565e332ac1d86463a84de7819d08417662eb6d330e73461dfe971f`
verified. `inspect_evidence_v2.py` read the full supplied copied logs/receipts
and checked their hashes, plus the prior author evidence manifest and original
outputs; `evidence-ledger-v2.json` retains that inspection. Baseline checks apply
to candidate
`d8633518c386a6fb846672a6a3b9dcd5a6f890ac5ab4f0b3572165892077f7d6`,
and current dependency/native preparation applies to input candidate
`f7bc1fa95959ec13092ccf191ca3105826d044e768f43d2bcdf7f32e5f84c84f`.
These are historical broker results, not checks of the subsequently edited
document. The author measurements below are separate.

| Retained item | SHA-256 |
| --- | --- |
| `artifact-manifest-v2.json` | `03294362e916d53419f753b4f2d5f57ea9bcd86eb92220079202cd1c5b049f77` |
| `quiet_probe_v3.py` | `b5e50fc1b2cb09a4b9045fb5f9ad8ff737a56121eb5b5f3f7f97af44b581da34` |
| `fixtures_v2.json` | `7badd2e13148c086b40e0ab6e65e47fb7853551b072797c077cbae505197e37e` |
| `quiet-probe-03/stdout.txt` | `d27fa6b6533809af7c03808850ed3a47daa9bf17ca509b968fd006646ce91f16` |
| `quiet_edges_v1.py` | `b249ee628a85a2592d6aadfc07a3a35bc7e09a325d8185dd2326c94c2d9466cd` |
| `quiet-edges-02/stdout.txt` | `0ecf438d02c403b6e50f2e048cec24c5efd0168cb78d06c19c1f11e57f8c6fcc` |
| `analytics_probe_v3.mts` | `36bfcc81a486df760fc5f0086e0ae8420475f134dc40e6c77c0faa9c155e4fce` |
| `typescript-probe-03/stdout.txt` | `4d253417664fff8ec188ad98b37b0e4dd6e423972df31d083301b4919f04120c` |
| `source-manifest-v2.json` | `fb6b972097c9284b0a3a063718164c43750722208e5018452910e6b057881058` |
| `worker-tests-02/junit.xml` | `6f719a6129f06f458138cf562a91e013ff7a0759a34ccccd497e3940c7a3c39c` |
| `api-tests-03/junit.xml` | `8b5f123cc9fe24d8c44245334de9abf50f0a68ceedecccac3e93984089061073` |
| `pnpm-lock.yaml` (source) | `f58933349adc295cad3ff96ba14d5cae6a62b37fcb83d12fe94a72063aaa0b75` |
| `workers/automation/uv.lock` (source) | `c7a3609dab6c93fdaa9f247ef88a943d74629457042ce64d7a92320092ba40d6` |

### Fixture bounds and injected seams

`quiet_probe_v3.py` imports current Gmail feedback, outreach, schema and
projection-builder modules normally through the repository source path. It
sets the synthetic workspace before imports and creates exact-v12 databases
through `create_exact_v12_schema`; exact-schema assertions run again on stored
scan results. Its five scan databases each contain one local job and another
tenant's job sharing its ID. Scan calls use one anchor, at most four messages
and a seven-day window. The maximum expanded fixture body is 13,055 characters,
with an explicit 14,000-character guard. Its anchor database contains three
local jobs and one other-tenant control; ten analytics databases contain one
job each, except the four- and five-job sample fixtures. A process deadline of
90 seconds guards the probe; the tenant/seam probe has a 60-second deadline.
Neither timed out.

The injected Gmail client returns fixed metadata and bodies; it records search
arguments and body-read calls and never constructs an authenticated client.
For these scans the observation/search clocks are 2026-06-01 10:00 UTC through
2026-06-08 10:00 UTC, with message receipt at June 1 12:00 UTC. Metadata queries,
summaries, full evidence/suggestion/outcome rows, stored events and published
notifications are in the original output. Private anchor/link readers are
diagnostic calls, not copies of their algorithms. Synthetic identifiers,
contact values and application data are isolated in the allocated workspaces.

For analytics, the fixture injects successful apply-run projection rows and
canonical outcome rows, records a synthetic seed event, then calls the real
`ProjectionBuilder.refresh()`. Those inputs bypass live application execution
and API outcome review, explicitly exercising projection consumption only.
`analytics_probe_v3.mts` copies those ten disposable exact-v12 databases into its
own workspace, normally imports the current TypeScript projection, read-model
and application-feedback modules, and calls their exported functions. Its
90-second deadline did not expire. The outcome-decision fixture injects one
synthetic evidence row and pending suggestion; it does not execute a provider
scan or an HTTP request.

### Observed scan results

Each row below made one search and selected one anchor. Evidence and suggestion
counts are newly stored rows; all created suggestions remained pending. Every
scan left the initially empty reviewed-outcome table empty.

| Fixture | Returned messages | Link score | Body reads | Evidence / suggestions / ingestion events | Observed suggestion |
| --- | ---: | --- | ---: | --- | --- |
| Empty search | 0 | — | 0 | 0 / 0 / 0 | None; no rejection or `no_response` persisted. |
| Newsletter metadata with decision words only in snippet | 1 | 0.4 | 0 | 0 / 0 / 0 | One unlinked candidate. |
| Exact-threshold application metadata | 1 | 0.7 | 1 | 1 / 1 / 1 | `unknown`, classification confidence 0.25. |
| Application/title metadata with confirmation body | 1 | 0.85 | 1 | 1 / 1 / 1 | `applied_confirmation`, confidence 0.9. |
| Interview, ambiguous, negated and long-body fixtures | 4 | 0.85 each | 4 | 4 / 4 / 4 | `interview`, `rejection`, `offer`, `offer`. |
| Repeat of stored confirmation ID | 1 | Previously linked | 0 | 0 / 0 / 0 new | Duplicate count 1; prior evidence/suggestion retained. |

The exact-threshold signals were recipient, time window, company and outcome
term; title added the above-threshold signal. Persisted ingestion payloads had
exactly `evidenceId`, `suggestionId`, `provider`, `suggestedKind`,
`classificationConfidence`, `linkConfidence`, `linkSignals`, `stage`, `level`,
`message` and `jobId`. Published notifications were also captured. No body,
snippet or contact values entered those event payloads.

The direct classifier calls produced these actual ambiguous results:

| Synthetic input | Observed kind / confidence |
| --- | --- |
| “This is not an offer letter.” | `offer` / 0.95 |
| “Congratulations on updating your account settings.” | `offer` / 0.95 |
| “Unfortunately the calendar service is down. Please schedule an interview.” | `rejection` / 0.9 |
| FAQ quoting “not selected” as a possible future status | `rejection` / 0.9 |
| “Please confirm availability for the assessment.” | `interview` / 0.9 |
| “We are still processing your request.” | `unknown` / 0.25 |

In the long-body scan, the offer trigger followed 13,020 neutral characters.
The classifier suggested offer, but the stored 12,000-character body contained
no `pleased to offer` trigger. Its stored hash was
`90d9a9ba306ac9e95f05423aad87f9a4768965a8320e69624d33cfc82b09ce63`,
which the extraction independently recomputed. This reproduces a retained-text
auditability limit; it does not establish classifier accuracy over real mail.

### Observed anchors and tenant boundaries

For one job, the fixture provided June 1 job time, May 31 confirmation time and
May 30 non-dry-run success time: the selected anchor was May 30. A May 1 dry-run
was excluded. A second job anchored June 3; a third had no application time and
used June 1 discovery time with applied status. The one-anchor selection chose
the June 3 job. All readers used canonical enrichment URLs; removing the first
job's enrichment returned an empty application URL even while a historical
application alias existed. The other tenant's shared job ID supplied no anchor.

`quiet_edges_v1.py` additionally seeded the same provider message ID in the
other tenant. The local scan still read and stored it once, then its repeated
scan read no body and counted one duplicate. The local synthetic `no_response`
row remained the only local reviewed outcome. The other tenant's jobs,
enrichment, outcome, evidence, suggestions and events were byte-equivalent as
serialized before/after row snapshots; snapshot SHA-256 was
`b8853c7dbe654e5ed8ae205c35f7023e2314e639022f17b7f651a701f612b234`.

Two diagnostic `_link_metadata` calls deliberately bypassed the normal client's
filtering: wrong recipient and outside-window metadata each still linked at
0.75 with other lexical signals. These are helper-seam measurements, not live
Gmail ingestion failures. They show why the linker alone cannot attest recipient
or window compliance; the normal transport remains a separate boundary.

### Observed reminders and production analytics

Submission at June 1 10:00 UTC produced a first suggestion at June 8 10:00 UTC
(`application_submitted`). Supplying that due time as the previous follow-up
produced June 22 10:00 UTC (`no_reply_nudge`). Logged reply and missing submission
anchor both returned no suggestion. A scheduled reminder was not due at June 8
09:59:59, and was due at 10:00:00 and 10:00:01. Completed and dismissed states
were not due on June 9. These calls did not schedule a send or infer rejection.

The following counts and minute lists came from the real Python dashboard
builder after public refresh:

| Synthetic canonical history | Applied / reply / interview / offer / rejection | Response-minute samples |
| --- | --- | --- |
| Missing outcome | 1 / 0 / 0 / 0 / 0 | `[]` |
| Confirmation only | 1 / 0 / 0 / 0 / 0 | `[]` |
| `no_response` | 1 / 0 / 0 / 0 / 0 | `[]` |
| Recruiter reply at 12:00:30 after 10:00 application | 1 / 1 / 0 / 0 / 0 | `[120]` |
| Interview with missing or invalid application clock (separate cases) | 1 / 1 / 1 / 0 / 0 | `[]` in each |
| Rejection before application time | 1 / 1 / 0 / 0 / 1 | `[]` |
| Reply at 11:00:59, later interview at 15:00 | 1 / 1 / 1 / 0 / 0 | `[60]` |
| Four replied jobs | 4 / 4 / 0 / 0 / 0 | `[120, 120, 120, 120]` |
| Five replied jobs | 5 / 5 / 0 / 0 / 0 | `[120, 120, 120, 120, 120]` |

The TypeScript probe refreshed all ten copied fixtures with the production
builder and compared their complete raw conversion objects with the Python
outputs: all ten comparisons passed. It then called the production read-model
summary. Four replied jobs yielded a null reply rate and null response median;
five yielded reply rate 1 and median 120 minutes. Single-job histories also
returned null rates and medians; invalid, missing and pre-application clocks
retained zero timing samples. These are measured fixture results, not proof of
general cross-runtime equivalence or policy effectiveness.

In the missing-outcome database, the TypeScript probe called
`recordManualApplicationOutcome` with `no_response` and a synthetic private
note, then accepted the injected interview suggestion with an explicit receipt
time. Two reviewed outcomes were stored. Repeating acceptance returned the same
outcome ID and created no third outcome. The accepted suggestion and complete
canonical rows/events are retained in `typescript-probe-03/stdout.txt`. Event
serialization contained neither the private note text nor the synthetic body;
the manual outcome event carried a note-presence flag. This exercises current
local review functions, not the future quiet-review lifecycle.

### Focused regressions, preserved attempts and limits

`worker-tests-02` executed all five selected worker test modules through
`uv --project workers/automation run --no-sync --locked --all-extras pytest -q`
with owned `--junitxml` output. `--no-sync` consumed the controller-prepared
environment without dependency preparation by this role. Console and JUnit
agree: **59 executed, 59 passed, zero failures/errors/skips**, exit 0; console
reports 2.82 seconds. The 180-second subprocess deadline did not expire. These
tests include synthetic Gmail clients, scan-handler replacements and controlled
database/concurrency fixtures, not live provider or deployed-worker compliance.

`api-tests-03` used the recorded absolute Corepack executable with
`pnpm --filter @jobctrl/api exec vitest run test/application-feedback.test.ts
test/application-feedback-v7.test.ts test/projections.test.ts --reporter=junit
--outputFile=<owned-report-path>`. Its complete console output and owned JUnit
report are retained: **104 executed, 104 passed, zero failures/errors/skips**,
exit 0, split 46/3/55 across those modules. The 180-second deadline did not
expire. These tests use synthetic databases and in-process API calls, with
mocked worker scanner/dispatcher/runtime seams; they do not establish live Gmail
or deployed-runtime compliance.

Earlier originals, wrappers and complete outputs remain in the previous
evidence allocation, relative to the same controller `role-artifacts` root:

```text
authoring/implement/726c3ec6b8a55f7ad7ad6b48e5a367c0428f9a64941ae13a3292eab78128cef4
```

Its original `artifact-manifest-v1.json` has SHA-256
`d913fa5acdeea08a06af778a40580241adbb677ab1dd968992cb6201d0131289`.
These are historical author attempts associated with input candidate
`9b8c1e6082f16def3ce3faf9dc5db2c465cfae2565745f56a3517540aac76224`,
not executions of the edited document:

- `quiet_probe_v1.py`, `fixtures_v1.json` and `quiet-probe-01`: exit 0, but the
  intended low/threshold labels were invalid because the company hint also
  matched an application-URL token. Actual scores were 0.75 and 0.85. Those
  outputs are historical fixture-setup observations, not proof of a threshold
  violation. Fixture v2 removed the overlap and measured 0.4/0.7/0.85.
- `quiet_probe_v2.py` and `quiet-probe-02`: exit 0, but its printed maximum-body
  bound was miscounted as 12,124. Version 3 computes the expanded fixture bound
  of 13,055 and guards it; its output is the measurement authority above.
- `api-tests-01`: exit 1 before tests, because the original wrapper unnecessarily
  disabled Corepack network lookup. The original wrapper and failure remain.
  Wrapper v2 removed that override.
- `api-tests-02`: the requested three-module Vitest command exited 254 before
  executing tests, reporting `Command "vitest" not found`. No API JUnit report
  was produced. `analytics_probe_v1.ts` is an original retained normally
  imported production builder/read-model/outcome probe; `typescript-probe-01`
  likewise exited 254 with `Command "tsx" not found`, without measurements.

The missing-tool failures above were resolved by controller preparation and
the new successful API/TypeScript executions. A further current-root attempt,
`typescript-probe-02` with `analytics_probe_v2.ts`, exited 1 before measurements
while tsx's CLI tried to create an IPC socket (`EADDRINUSE`). Its complete
original output remains retained. `analytics_probe_v3.mts` used Node's direct
`--import` tsx loader instead; `typescript-probe-03` exited 0 and produced the
measurements above. This launch failure is not evidence of a product listener
or service failure.

The current successful Python, TypeScript and focused regression attempts all
exited 0 without timeouts. Their bounded synthetic scope remains material:
search completeness, authenticated accounts, provider boundary semantics,
deployed runtime and external-reference compliance were not exercised. Process
deadlines and fixture counts are experimental guards, not production latency
guarantees.

<a id="future-architecture-not-implemented"></a>

## Future Architecture (Not Implemented)

The remainder is design for [#1035](https://github.com/ebarti/JobCtrl/issues/1035),
not a description of shipped behavior or measured thresholds.

### Explicit local assessment

A user would request a bounded assessment for selected canonical applications.
The request would disclose the selected tenant/job identity, application
instance/attempt when available, application clock and its provenance,
observation start/end, timezone, sources permitted for inspection, and work/body
read bounds. A job UUID alone is insufficient to disambiguate multiple
applications to one posting. Missing or conflicting application identity/clocks
would remain uncertainty, requiring clarification rather than silently using
discovery time as verified submission time.

A review would show independently:

- reviewed response history and the exact canonical outcome/evidence references;
- pending suggestions, ignored/corrected decisions and ambiguous application
  associations that still need review;
- assessed sources, query/selection bounds, clocks, truncation and retrieval
  limitations;
- an observation such as “No reviewed response recorded between these dates,”
  together with missing evidence and unresolved classification;
- user-controlled options to review evidence, record an outcome, or schedule,
  change or dismiss a reminder.

Pending mail evidence would be visible even if no reviewed response exists. The
review would distinguish “no reviewed response,” “no candidates returned,”
“pending response evidence,” and “assessment unavailable/incomplete.” None would
be translated into rejection. Unknown classification would remain a message
classification limit. A user-recorded `no_response` would carry its observation
period and provenance rather than becoming a verified employer decision.

Choosing an observation duration or surfacing an overdue-review prompt would be
a product design choice. The existing 45-day scan default and 7/14-day reminder
cadence provide no measured justification for a quietness threshold, confidence
cutoff, rejection inference or policy change. Policy/template comparisons would
remain descriptive until a separately specified evaluation addresses cohort
selection, censoring, review completeness and confounding.

### Identity, cancellation and refresh preservation

A proposed local review record would bind its result to a request ID, tenant,
canonical application identity, input fingerprint, selected clocks, evidence and
decision revisions, assessment generation and completion status. Broader events
and projections would contain only controlled status, references, counts and
times. Private evidence, contact values, notes and bodies would remain in
authorized detail storage. No new external account, model or network access
would follow merely from requesting a review.

Cancellation would stop additional searches/body reads and fence late writes.
A stopped or failed attempt would retain its partial work as explicitly partial
history, never present it as a completed assessment. No reviewed outcomes would
be created implicitly. Changed inputs during execution—application clock,
identity, permitted source, evidence decisions or reminder state—would invalidate
the request fingerprint before promotion. Late results could remain historical
but could not overwrite a newer review or decision.

A refresh would produce a candidate generation and promote it atomically only
after all required bounded steps succeed and the input fence still matches. The
last accepted review and its evidence bindings would remain readable during a
pending, cancelled, stale or failed refresh. New canonical evidence could be
shown as newer unreviewed information without rewriting the historical review's
meaning. Failure would not erase accepted evidence, reset reviewed outcomes or
mark an application rejected. These mechanisms are proposed; the existing scan
transaction and post-commit notifications do not implement this review lifecycle.

### Privacy and user decisions

The assessment would be local and read-only with respect to employer action.
Reviewing a suggestion, changing an outcome and scheduling a reminder would
remain distinct explicit user operations. A reminder would never gain send,
auto-apply or submission authority. Synthetic QA would use owned isolated
workspaces; real account access or outbound actions would require separately
scoped authorization and could not be inferred from this design.

Future proof would require bounded empty/unknown/ambiguous evidence cases,
multiple applications sharing hints, cross-tenant IDs, timestamp and timezone
boundaries, provider pagination/filter limits, missing clocks, truncated bodies,
duplicate and concurrent scans, and outcome-review timing. It would also require
cancellation during each stage, input changes before promotion, a lost response
after commit, restart/replay, failed-refresh preservation, private-payload
exclusion and user-edited reminder preservation. Any live provider/runtime
claim would require separately executed evidence. Source inspection and
synthetic doubles alone would not establish that claim.
