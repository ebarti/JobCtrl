# Python application journeys

Transformation #1428 replaces the legacy tests with a small E2E suite. The
recurring command is `corepack pnpm e2e`; append Playwright arguments to focus a
journey, for example `corepack pnpm e2e -- --grep 'approved baseline'`.
The command snapshots the Python package once, verifies its import origin and
starts the real default HTTP composition in a fresh owned workspace before
building the web app. An import or composition failure stops the run before
building or repeating per-journey startup. API, CLI and replacement workers use
the same frozen source tree and the canonical browser capability policy at its
actual checkout-relative location. The run records sorted source and web-build hashes,
preflight, build, journey and total elapsed time. Installed mode uses only the
specified extracted interpreter and assets under `JOBCTRL_E2E_PAYLOAD_DIR`, sets
the real bundled-runtime environment and rejects repository imports or escaping
paths. Installed mode does not copy source resources from the checkout.
Dependency installation belongs to runner setup and is included separately
in the hosted job's total. A listed scenario is not verified until its observed
result is recorded on the exact candidate.

The suite starts the actual Python HTTP server and worker, real Temporal,
SQLite, file storage and resume renderer. Browser requests reach the Python
application. Only external models, job sources, mail and other external APIs
are controlled. Model responses are explicit source-bound choices made for each
journey. They test authority, validation, persistence and failures; they do not
grade semantic accuracy or replay a corpus. Unexpected external calls fail.

There are no dispatch stubs, mocked internal API routes, domain/repository replacements,
direct database seeds, arbitrary sleeps or test retries. Startup waits and
assertion polling have explicit deadlines and inspect actual service state.
The Preparation admission-recovery journey forwards the genuine unchanged POST,
observes its real 202 receipt, then aborts browser delivery to reproduce a lost
acknowledgement. It invents no first-party response. A console allowance can
match at most one native transport error for that exact observed failed Request;
application exceptions and HTTP status classes remain failures. Intentional
conflict controls separately register each genuine browser response with its
exact method, 409 status, domain error code and full URL. That permits one native
resource message per observed response; extra requests, other refusals and
application messages still fail.
One Temporal server serves bounded, independent per-journey Python workspaces.
Processes and state are owned by the run; caller-selected application paths and
real credentials are never adopted. The IPC-connected process-group leader
reserves its group identity until cleanup and cleans its group if the harness
disconnects. Test evidence lives in an owned temporary run directory. Failed
synthetic state stays local for diagnosis; CI uploads selected logs, timings,
traces and reports and excludes databases, native HOME and provider state.

## Coverage ledger

The current configured inventory is **100 journeys in 33 project-file groups**:
**99 Chromium cases in 32 spec files**, plus **one demo case in one file**.
The all-project JSON listing has no inventory errors. Seven cases in two new
files cover typed requirements and the predecessor-generation upgrade. Listing
these scenarios is not evidence that the complete current candidate passed.

### Typed requirements generation and cumulative source proof — 13 November 2026

The [typed-requirements contract](../../plans/typed-requirements.md) adds six
[typed-demand journeys](../../../apps/web/e2e/journeys/typed-requirements.spec.ts)
and one [predecessor-upgrade journey](../../../apps/web/e2e/journeys/requirements-upgrade.spec.ts).
The affected cohort contains **23 distinct scenarios**:

| Scenario owner | Count | Exercised boundary |
| --- | ---: | --- |
| [Requirements](../../../apps/web/e2e/journeys/requirements.spec.ts) | 12 | Complete-catalog matching, source-bound quotes, strict refusals and accepted-state preservation |
| [Exact-result reuse](../../../apps/web/e2e/journeys/requirements-reuse.spec.ts) | 2 | Exact semantic-input reuse with destination publication/source fences |
| [Typed requirements](../../../apps/web/e2e/journeys/typed-requirements.spec.ts) | 6 | Four-category qualification, permitted evidence and explicit education alternatives; manually selected direct-demand refresh; correction support routes; non-English transition/skip; empty-demand no-score behavior |
| [Predecessor upgrade](../../../apps/web/e2e/journeys/requirements-upgrade.spec.ts) | 1 | Actual predecessor public writes, stopped-writer upgrade, retained history/accepted bytes, empty active generation, no automatic calls and incompatible durable-replay refusal |
| [Profile workspace](../../../apps/web/e2e/journeys/profile-workspace.spec.ts) | 1 | Peer sections, authored Language / Proficiency, autosave and Plate/export retention |
| [Baseline copy](../../../apps/web/e2e/journeys/baseline-copy.spec.ts) | 1 | Complete baseline and historical PDF bytes with zero resume model calls |

These **23 scenarios passed cumulatively across different source snapshots**,
not in one complete final-candidate run. The raw run outcomes retain failed
attempts and overlap:

| Portable run ID | Observed result | Build / journeys / total | Qualification boundary |
| --- | --- | --- | --- |
| `e2e-j9JpHS` | 19 passed; 3 setup failures | 7.656 s / 135.760 s / 145.273 s | Earlier snapshot; a nonpassing 22-case invocation, not 22/22 |
| `e2e-8wJcsH` | 1 passed; 2 setup failures | 8.263 s / 82.034 s / 92.179 s | Adds the typed cross-section source-fence negative case; invocation remains nonpassing |
| `e2e-AVaCEx` | 3 passed; 1 accessible-label selector failure | 7.942 s / 68.304 s / 78.105 s | Current production source: Profile/Languages, predecessor upgrade and English-to-non-English history/ranking/keyword behavior passed; correction-form lookup failed |
| `e2e-RFp02d` | 1 passed | 7.514 s / 8.353 s / 17.734 s | Current production source: repaired correction-form selector passed |

Deduplicating scenarios gives the cumulative 23: the first run contributes 19,
the second adds one source-fence case, the third adds Profile and upgrade, and
the last adds correction UI. The third run's English-language transition is an
overlap with the first. Raw passing counts must not be added as independent
coverage.

Earlier run identities remain separate:

| Run | Source candidate digest | Frozen Python tree | Web bundle |
| --- | --- | --- | --- |
| `e2e-j9JpHS` | `ec61743ccd3e700dd094d52a4374f410abd31ac1c27aea249f7323baf40e8691` | `79c384758ed6cb3ae4ae7e70f4052e81c309b8e78a36ecad691ea1f71e5ac528` | `313ba60235df89f4ff0df832fe9a674340db31bef2e34fc36eae21ce26d2ef14` |
| `e2e-8wJcsH` | `467b5ffc79ed4fbc148069a194ccf8a12d32ef72d593ec47206a3b49bd7f7523` | `34e49f46517484439c39272022fcdccdb7e2b7c80963b36d068a5290c837f0b8` | `23d49c88de71860a41b1e4ec6f236accafc5de9e7d7571be50c913fa257c1dcc` |

The two final runs share production source digest
`88fd506862bd9e7f5223775295b6e11be3ccfcdc848771bc1a06bb857b0022ed`,
frozen Python tree
`1684ec6a7e061e4a93226af41c50f71f3278180043801fbc98e4b174a0683f83`
and web bundle
`2bf6b2a70e3a7d408744cd817cbf35514414fe2346fa29b18ace7e027f560652`.
They establish **four passing scenarios against those final production
identities**, including a successful focused correction rerun; the earlier
nonpassing invocation is retained above. Dependency locks and built web bytes
remained unchanged during the recorded runs. Independent process readback found
no remaining run-owned processes.

At first publication, this was cumulative affected source proof: **there was no
complete 100-case final-candidate pass**, and all three hosted shards and their
aggregate were pending. Installed predecessor-upgrade
mode was not exercised because no installed payload was available. The source
predecessor journey does not establish installed-upgrade, live workspace
rollout, real-provider semantic quality, release or deployment proof.

#### Initial hosted run and readiness repair

The initial [PR #1478 run](https://github.com/ebarti/JobCtrl/actions/runs/43513681075)
tested commit `53545c79024bf8a00c4e06321112a3a85e6179a8`. All 100 listed cases
were attempted exactly once: **96 passed and 4 failed**, with no skipped, flaky,
retried, duplicate or unrun cases. JSON and JUnit agree. All ten non-Browser jobs
passed; the three Browser shards and their aggregate failed. Dependency locks,
frozen Python source and built web bytes did not change during execution.

The readiness case first exposed an outdated strict response assertion. Correcting
that assertion then exposed a real client decoder omission: the no-Profile
response included `contract_version`, while its strict decoder rejected it. The
repair explicitly validates the current generation in both pending-readiness
variants and preserves strict no-Profile validation. Legacy operation metadata
is decoded and displayed as history without offering an incompatible retry.
The other hosted failures were obsolete wording/tour assertions and one remaining
old-generation empty response at the controlled external model boundary.

The focused repair run `e2e-vcs6Z0` passed **5/5 real application journeys**, with
zero retries: both failed manual-refresh scenarios, first Profile setup, the
predecessor upgrade with operation-history/no-retry checks, and the full demo
tour including accepted PDF and no product-network calls. Build time was
**8.017 seconds**, journeys **69.426 seconds** and total **79.342 seconds**.
Source candidate `88fd506862bd9e7f5223775295b6e11be3ccfcdc848771bc1a06bb857b0022ed`
and Python tree `1684ec6a7e061e4a93226af41c50f71f3278180043801fbc98e4b174a0683f83`
were unchanged; the repaired web bundle was
`533b937fd0eee13e888c2fed0d8e36197f106747db0d29c135f1c8cc47d5de72`.
These five passes do not replace full hosted qualification of the repair head.
The [current PR checks](https://github.com/ebarti/JobCtrl/pull/1478/checks) are the
authoritative later result; earlier failures remain retained in this ledger.

### Historical 93-journey inventory

The preceding configured inventory was **93 journeys in 31 spec files**:
**92 Chromium cases in 30 files**, plus **one demo case in one file**. Its
all-project listing retained the complete 77-case/29-file parent and added
14 cases in two files for batched qualification and exact-result reuse,
plus two initial-assessment admission cases in the existing Fit batching file.
No parent case was removed at that inventory. The original observations and
candidate-specific proof below remain historical; they do not qualify the
current 100-case candidate.

The 77-case parent comprised the earlier 57 plus three direct-Jobs search
journeys, five provider-isolation/recovery journeys, one native accounting-setup
journey and two accounting-classification
journeys, plus five initial-assessment/recovery journeys, two exact-quote binding
journeys, one accounting-actionability journey and one Jobs deletion/SSE journey.
The direct-Jobs cases exercise saved launch and live
counts across navigation/reload/tabs, lost-acknowledgement recovery and exact-run
stop, and simultaneous two-tab admission. Historical complete-suite results
below retain their original 57-case scope; they do not qualify the new inventory.

### Batched qualification and exact-result reuse — 13 November 2026

The source candidate for [#1473](https://github.com/ebarti/JobCtrl/issues/1473)
collects current person-qualification authority before sending the complete
missing set in one `fit.qualification-batch` request. One complete partition
must validate before atomic new-assessment publication. Each row retains its
own assessment/canonical identity and result fingerprint, distinct from the
shared immutable raw-batch receipt/fingerprint. All-current sets make zero
qualification calls. Explicit manual refresh keeps complete-catalog impact,
fixed source/job scope, durable checkpoints and existing work limits.

Initial job admission is separate: a job with no prior score may reuse current
authority and batch the remainder of its fixed requirement set during its
explicit preparation, including when earlier shared qualifications predate
saved Profile changes. Captured-head comparisons fence publication, history is
retained and other jobs' scores are unchanged. Previously scored jobs still
require manual affected-match refresh for changed qualification; saves and
reads start no work. The earlier 12- and 39-case runs below predate this admission
repair; the repair has its own 25-case result below.
The two added [Fit batching cases](../../../apps/web/e2e/journeys/fit-batching.spec.ts)
target first assessment with historical and unseen qualifications after a
preference edit, preserved old scores and manual-refresh boundaries, zero-call
replay, and a held batch refused after a competing historical-head publication.
A successful inventory listing is not an executed passing result.

Requirements and role analysis use exact complete content and frozen
provider/model/effective effort/configuration for model-call reuse. Catalog
matching additionally binds the complete incoming inventory and current
catalog. Every reuse revalidates canonical receipt and owner rules; each
destination still has its own actual posting binding and publication guards.
Forced actions retain distinct durable refresh identity. Gateway schema success
alone is not owner acceptance. No lexical fallback, chunks, truncation or
rewritten model response establishes authority.

The actual source run `e2e-Rvc4sO` passed all **12 focused Fit cases** with zero
retries, skips or flaky cases. These cover cold, mixed and all-current reuse;
six complete-partition/citation refusals; in-flight Profile and requirement
changes; public-action cancellation; configured two-item/two-call manual work
limits and exact replay; and checkpoint retention across actual worker
replacement. Its frozen Python tree was
`25f589f9477d3f857e93dda40ffe2c084966bee3073db33ea1188212d03b6c7e`.
The combined invocation was **nonpassing**: its two exact-reuse cases failed,
so the 12 passing Fit cases are partial proof, not a 14-case or complete-suite
pass. That earlier snapshot included a since-retracted optional Jobs synthesis
guard outside the exercised Fit paths; it does not qualify the exact final
candidate.

The subsequent source run `e2e-aZHNKB` passed **39/39 affected journeys**: the
two new Requirements/role-analysis reuse cases and 37 existing journeys covering
Requirements, manual affected-match refresh, search, worker recovery and
tailoring. The reuse cases exercise exact body and destination bindings,
changed body/catalog/model/effort, and explicit force actions. The other
journeys retain complete-catalog validation and refusals, fixed manual scope and
work allowances, queued/in-flight source fences, cancellation, actual worker
replacement, no automatic reassessment, and accepted-PDF preservation. The run
used one worker, zero retries, zero skips and zero flaky cases, with a clean
browser console. Build and dependency locks remained unchanged.

Its frozen Python tree
`c1c4c0270bf9c2929942e6be27f83c14b0e1318a46fe9a72f81a1475aba0c6e5`
matched production and the live pre-guard source at that verification. The source
candidate fingerprint was
`e4e2ac635c7c05587bc935553fbdfb9c27b0e4356e47d4857e121067ccaa23ce`;
the web bundle was
`f201a831b79682e521c8aacf8ba3e36fe06216a9cfe8f1e5a62b401ce19168f1`.
The wrapper measured **258.498 seconds** for journeys, **267.876 seconds** total
and **7.940 seconds** for the build. This qualifies the named source paths on
that snapshot, not the complete current inventory or the exact final published candidate. Check
[PR #1475's checks](https://github.com/ebarti/JobCtrl/pull/1475/checks) for
whole-inventory qualification of the reviewed head; only completed successful
required checks for that exact head establish the hosted result.

The first-assessment admission repair passed **25/25 journeys** in
`e2e-dEFAbJ`, using
`corepack pnpm e2e -- fit-batching.spec.ts manual-refresh-guards.spec.ts search-assessment.spec.ts`.
Both added admission/history and historical-head race cases passed, alongside
batch partition/citation refusals, source-change fences, cancellation,
existing-score manual-refresh guards, bounded work/replay and actual worker
replacement. The runner used one worker, zero retries, zero skips and zero flaky
cases; build outputs and dependency locks remained unchanged. Its frozen Python
tree was
`4f6f35a12a0f9617341772b8250ab87eb4f7015684b915c40f4b5214c7597d01`,
with source candidate
`8c8b64b4b9d63640b8e57be1d5eb351df5fb27a0bc1d0da15437caa4aeb54dcd`
and the same web bundle as the 39-case run. The wrapper measured
**172.929 seconds** for journeys, **182.873 seconds** total and **8.371 seconds**
for the build. This is affected source proof; exact reviewed-head whole-suite
and terminal provider evidence remain owned by the PR checks and issue linked
here, without a new full-CI or live-provider success claim.

The preceding authorized five-job observation took **91 minutes 59 seconds**
and recorded **62 qualification calls and 40 qualification reuses**. These are
aggregate operational observations, not a synthetic replay corpus or a general
performance guarantee. No job or Profile identity belongs in the public record.
[Issue #1473](https://github.com/ebarti/JobCtrl/issues/1473) owns the aggregate
repeat five-job provider results and before/after timing. Check its terminal
operational evidence, including exact candidate, model/effort, command,
receipt/call counts, preservation checks and elapsed boundaries, before
concluding improvement. This ledger adds no post-change operational timing or
provider-pass claim. Source behavior and a smaller planned call count alone
prove no new end-to-end timing, provider quality, release or deployment result.

### Five-job QA follow-up — 12 November 2026

The skill-group heading is now the existing label field itself, with the
accessible name **Skill group title**. The duplicate Label field is removed.
The real Profile journey verifies keyboard focus, Tab order, successful autosave,
unchanged group identity/items after reload, and individual skill/group creation
and removal. Desktop and mobile images were inspected; the shared heading
typography and constrained input fit without overflow.

Requirements extraction now asks the external model for an exact source ID and
verbatim quote. The owner derives canonical offsets only when that quote occurs
exactly once in the frozen source. This removes model character-count arithmetic
while preserving strict source binding, the numeric canonical/manual API,
complete-catalog matching, raw model receipt/cache equality and publication
fences. Non-verbatim, foreign, repeated, overlapping and old numeric selections
refuse without replacing accepted requirements. The versioned model schema
prevents old extraction output from becoming new authority.

Accounting reads separately report current policy blockers and incomplete
historical usage. Unknown receipts and null totals remain inspectable; they do
not create an accounting action item when no enabled monetary or affected-lane
token policy needs those values. Actual finite-policy admission still refuses
before external dispatch. This makes no claim about the cause of legacy
uncertainty and does not change canonical workflow recovery or receipt status.

| Focused run | Observed result | Boundary |
| --- | --- | --- |
| `e2e-pOoJX8` | 2/2 passed; 58.393 s total | Real Profile editing plus all 104 rendered workspace views; keyboard/autosave/reload identity and 1440/390 skill-heading geometry. |
| `e2e-smJWGP` | 1/1 passed; 17.568 s total | Genuine stale Fit, then hide/unhide, delete/restore and reviewed permanent deletion. Actual browser `JobUpdated` frames and fresh Digest HTTP responses update counts without document reload. |
| `e2e-Za4RIF` | 4/4 passed; 84.465 s total | Public cancellation, actual worker kill, continued uncapped work, unrelated finite lane, and opposing finite monetary/affected-token refusals with accepted artifacts retained. |
| `e2e-g1COJa` | 13/13 passed; 49.452 s total | Exact Unicode quote binding, cache reuse after catalog refusal, malformed/ambiguous selection preservation, existing catalog invariants, and ordinary Start search through three saved fit scores. |

All four runs used zero retries and retained unchanged dependency locks and web
build outputs during their execution. The final Requirements run used Python
tree `c8e72d78c39ba1e6f4e2c0ed354164b523e5637d2cd215fc141756aae4cff64a`
and web bundle `13150ebf6a162dd792db753da859fdbe6dfa9294a07a7788822305cd55a74e68`.
A subsequent Requirements README clarification changed only documentation, not
tested Python bytes. TypeScript, frontend boundaries, scoped Python lint and
diff checks passed. Independent review found no actionable defect in the
skill-heading, accounting-actionability or exact-quote production patches.

The earlier live tab's stale attention count was not reproduced: the normal
deletion subscription already existed and the real lifecycle proof passed.
No speculative production invalidation change is claimed. The failed sandbox
loopback preflight was an invocation failure, not an application result.
These focused runs do not claim one complete 77-case execution or successful
live provider semantics. The separately authorized five-job operational pass
and exact-head hosted qualification are recorded in issue #1472. No release,
deployment or user acceptance is implied by source verification.

### Hosted capacity follow-up for 77 journeys — 12 November 2026

[CI run 43296217614](https://github.com/ebarti/JobCtrl/actions/runs/43296217614)
on `a5f923ebe6f983c91deac6bc84a02e4a95d5478d` did not qualify the complete
inventory. Shard 1 reached the unchanged 720-second global ceiling after
42 passes, leaving three Optional cases unrun: compensation evidence,
interview preparation and reduced-composition manual Jobs. Its report has
zero individual assertion failures and two global suite/teardown timeout
errors. Shard 2 passed all 32 cases. The combined outcome is **74 passed,
3 unrun**, not 77/77. Both shards retained the frozen Python tree
`82e0be6d9cf02995667f44a2797b7970f52c14943fafc4879d3ac6255902eccc`
and web bundle `13150ebf6a162dd792db753da859fdbe6dfa9294a07a7788822305cd55a74e68`.
Dependency locks and built web bytes remained unchanged during execution.

The preceding green [CI run 43269824441](https://github.com/ebarti/JobCtrl/actions/runs/43269824441)
on `9069353d45ebf93330adf7341219610a9024bf03` had only 73 cases. The downloaded
JSON reports record these suite elapsed times, including fixture setup and
teardown:

| Candidate / inventory | Shard 1 | Shard 2 |
| --- | --- | --- |
| `9069353d` / 73 | 43/43 passed; 687.907 s | 30/30 passed; 558.566 s |
| `a5f923eb` / 77 | 42 passed, 3 unrun; 720.003 s | 32/32 passed; 660.072 s |

The 40 completed cases shared by shard 1 in both runs consumed 655.530 s
before and 658.519 s after, measured from successive case start timestamps;
their median wall-time ratio was 1.004. The new Jobs deletion/SSE and accounting
actionability cases added 12.426 s and 35.441 s, respectively. Their combined
47.867 s exceeded the prior shard's 32.093 s remaining budget. This localizes
the observed failure to cumulative shard capacity; it does not establish a
general application performance regression or a transient infrastructure fault.
The unchanged file-level grouping keeps the eight-case Optional file together,
producing a 45/32 case split as the inventory grows.

The scheduling repair uses standard Playwright `--shard=1/3`, `--shard=2/3`
and `--shard=3/3` on three independent runners. Native JSON listing measured
**26 cases / 11 files**, **36 cases / 11 files**, and **15 cases / 7 files**.
The union equals the complete **77 cases / 29 files**, with zero overlap,
missing cases or extras. No case, application behavior or fixture changed.
One worker, zero retries, all existing case/fixture/action/assertion deadlines,
the 720-second global ceiling, the 14-minute journey step and the 20-minute job
limit remain unchanged. Matrix fail-fast remains disabled; the stable
**Browser / UI checks** aggregate requires all three shards to succeed.
Evidence names now use `python-application-journeys-shard-N-of-3-<run_attempt>`.

This is scheduling and partition-inventory proof. It is not an executed
three-shard pass: hosted qualification of the repaired candidate remains
pending in the [PR checks](https://github.com/ebarti/JobCtrl/pull/1470/checks).

### Populated Fit presentation follow-up — 12 November 2026

The first completed live result exposed dense, unspaced requirement explanations
and repeated empty wording rows. The presentation now separates the saved score,
literal qualification outcomes, full requirement text and contribution metadata.
Named native disclosures retain rationale, exact evidence, source revisions,
determination IDs and correction controls. Empty current coverage describes only
the current result; it does not infer that wording has never been assessed.
An already completed job is identified separately while its wider assessment
run remains active, retaining the same busy guard and whole-run stop scope.

Two existing journeys were extended; the inventory remains 77. The final focused
run `e2e-jnJYH6` passed 2/2 with zero retries or skips in 21.638 seconds. It compares
full requirement and rationale text with canonical saved API data, exercises
gap/evidence/correction disclosures without changing the score, and holds a
second job's qualification while inspecting the completed first job. Desktop
and mobile result, audit and correction screenshots were inspected. Dependency
locks and the built web bundle remained unchanged during execution.

Independent review found and corrected the empty-coverage history inference,
then cleared the production behavior and screenshots. A subsequent copy-only
polish calls the remaining cohort "other jobs in this run"; it changes no guard,
payload or action. Complete candidate qualification is recorded in the
[PR checks](https://github.com/ebarti/JobCtrl/pull/1470/checks) and issue #1472.

### Final QA corrections — 12 November 2026

This follow-up to the Original redesign addresses the reported disabled search,
duplicated Jobs filters and overcomplicated achievement cards. Valid Remote and
posting-age preferences now reach isolated board requests; source restrictions
and failures are recorded per source without disabling compatible acquisition.
Jobs uses column-owned criteria with one active-filter summary. Achievements
lead with saved/current wording and Edit wording, with factual editing, coaching,
ordering, removal and audit history available through named secondary controls.

The new [provider journeys](../../../apps/web/e2e/journeys/discovery-provider-scopes.spec.ts)
run the installed JobStreaming 0.0.5 request/parser/checkpoint implementation
against an owned loopback transport. They retain real Temporal, Python HTTP,
repositories, SQLite receipts and worker processes. The ATS cases drive the
public extension pairing, claim, task, DNS and result protocol; they do not
replace the registered adapter or claim execution by an actual Chrome extension.

| Added journey | Observed boundary |
| --- | --- |
| Remote posting age and isolated failures | Indeed retains Remote while its incompatible acquisition age parameter is omitted. Local admission honors the exact saved 73-hour cutoff and recorded date precision. Old, unknown, ambiguous and future dates are excluded with receipts. ZipRecruiter's actual missing-auth refusal and Glassdoor's unsupported scope remain attributed to their boards in both selected orders. All-failed differs from an empty completed source plus a failed source. |
| Committed cursor recovery and cancellation | Wait for the actual persisted SDK cursor and three explicit acknowledgements, including one accepted and two filtered receipts, then crash the worker. The replacement resumes that cursor under the same run and cutoff reference, preserves unique accepted jobs and refuses jobs delivered after settled cancellation. |
| Board failure after full capacity | A prior board failure survives worker loss after Indeed fills the shared new-job limit. Recovery makes no additional provider request and retains a partial result. |
| Completed ATS plus failed board | An actual registered ATS completes through the public extension protocol and fills capacity; another acquisition remains interrupted. After worker loss, canonical completed/budget-exhausted units and the failed board produce partial rather than failed. |
| Failed ATS plus completed board | A registered ATS records `request_failed` before Indeed fills capacity. Recovery retains the exact source ID/code, accepted job and partial result, making no additional external call. |

The existing Jobs journey additionally exercises column bounds/availability,
hidden-column access, simultaneous canonical and literal predicates, atomic
clear, saved views, exact timestamp preservation, return selection/scroll and
mobile filter geometry. The Profile journey exercises compact desktop/mobile
cards, factual editing, wording proposals, the immediate reload/recovery race,
exact approvals, history and full-width textarea geometry. The offline demo
retains actual editing and its accepted PDF flow through the renamed controls.

Observed source runs, with **one worker and zero retries** throughout:

| Run | Result | Build / journeys / total (ms) | Scope |
| --- | --- | --- | --- |
| `e2e-QM8ccy` | 14 passed / 3 failed | 9,211 / 262,484 / 273,073 | Initial 17 affected cases, including the 26-surface/four-width matrix and 104 captures. Failures were SDK recovery observation timing, a viewport changed before a retained-scroll assertion, and old demo control names. |
| `e2e-0BaV1j` | 3/3 passed | 8,513 / 67,808 / 77,601 | Jobs, Profile and offline demo after viewport/name repairs and the inspected wording textarea CSS repair. |
| `e2e-SEp88O` | 3 passed / 3 failed | 7,802 / 109,006 / 118,163 | Remote-age/failure isolation, capacity recovery and generic Discovery passed. Cursor recovery crashed before the checkpoint commit; the two new ATS journeys incorrectly read raw source arrays from an aggregate telemetry response. |
| `e2e-fzI11x` | 3/3 passed | 7,581 / 125,357 / 134,217 | Corrected committed-cursor/cancellation and both registered-source restart journeys. |

There are **19 distinct affected journeys with passing observations** across
these runs. This does not claim a single full 65-case pass. No skipped, flaky or
retried cases occurred. The failed attempts remain failures in this record.
The ordinary 90-second case, 150-second demo and 720-second global limits remain.
The explicit post-crash observation now permits 45 seconds, matching the existing
terminal observer and allowing the real 30-second heartbeat expiry; no production
timeout changed. The corrected cursor test waits for committed checkpoint state
through a bounded, read-only observer restricted to its owned synthetic workspace.
It does not infer acknowledgement from the next outbound request. ATS barriers
use the existing public aggregate telemetry and exact source-registry fields.

Image inspection found an actual inherited CSS defect after the initial passing
Profile assertions: a legacy textarea grid area pushed the wording editor into
half its container. The owning Profile style now resets that grid placement.
The final 1440/390 captures and geometry assertions passed. Filter screenshots
disable transition animations so they show the settled dialog. Public guide
images contain only owned synthetic state; private local-QA data is excluded.

| Final recorded boundary | SHA-256 |
| --- | --- |
| Python package, `e2e-fzI11x` | `c80730f1d6ca07560e7de5a388d791d592ad6f28a43955141e7233fda260efbe` |
| Runtime capability policy | `7d360eeba42582a39895f98b5596eaf26621be4b8061fc3067918cd33dafa8fd` |
| Web build, all three final focused runs | `c994af31aa43f1b6df517a28e9d605119fab85ab9a8734161066dc4dec1c7de3` |

The final two provider runs have identical Python code; only the feature README
changed their package hashes (`e2e-SEp88O` was
`8976e8d0c732fc8b8daaf7d36b0d66db2da221153cf4e39f167eec072ca60fca`).
Locks and built assets remained unchanged within each run. The runner was macOS
arm64, 12 CPUs, Node 26.13.0. Web type checking and boundary lint, Python Ruff and
whitespace checks passed. Independent review closed the canonical failure/
fulfilled-unit recovery defects and the browser GET/header serialization repair.
Independent process/listener readback found no remaining owned-run process,
recorded initial worker or API listener across all four runs: 58 recorded
worker/API process IDs and 31 API ports were checked. Five failed synthetic
workspaces remain for diagnosis; successful workspaces were removed. The local
interactive QA app is separately owned and remains running.
The documentation build resolved 16,175 references across 476 emitted files.
The first rendered-docs attempt lost its preview connection after a concurrent
documentation rebuild replaced that preview's output. That attempt is invalid
as complete qualification; the final check is run against a fresh preview after
the build finishes, with no concurrent output changes.
The subsequent complete rendered run reported two failures: the public homepage
copy of the Jobs image was stale, and the normal-flow check still required the
retired Search for jobs control label. The public image now matches the refreshed
synthetic source image; the check requires both Start search and Search
preferences. All other interaction, theme, contrast, image and navigation checks
remain unchanged.
These checks do not establish live Indeed availability, successful live
Glassdoor/ZipRecruiter authentication, semantic model accuracy, participant
usability, installed-release qualification or deployment. Hosted whole-head
qualification remains a separate delivery gate.

### Direct Jobs search and inline progress — 11 November 2026

Jobs now launches the confirmed saved Profile/Discovery criteria directly and
keeps canonical progress above the table. A shared controller owns compact and
one-off admission, exact recovery, progress and stop. New requests are fenced to
the same database incarnation as the saved preference reads. Server admission
serializes search requests across tabs before planning begins; same-key retries
retain their original action. Unknown reads remain unavailable, and explicit
terminal partial results outrank stale acquisition history.

Eight distinct affected journeys are qualified across these source runs:

- `e2e-1zdf3j` passed six cases: Jobs filtered-view return, independent Discovery
  execution, Search preferences/autosave/place binding, direct Jobs search,
  simultaneous two-tab admission, and all 26 surfaces at four widths (104
  captures). Its seventh case failed because the cancellation test released a
  successful final provider page immediately after requesting stop; completion
  legitimately won that race. This remains a **6/7** run, not a complete pass.
- The corrected test holds the external source until cancellation settles.
  `e2e-OhEbaz` passed **2/2**: lost-acknowledgement/exact-run cancellation
  (25.0 seconds) and the full offline demo/edit/approval/PDF path (29.5 seconds).
  The command completed in 80.597 seconds. No first-party result was invented.
- Both used the same production web bundle, SHA256
  `230fd05cd60ea33a0d868f69dfcc9e0aed756b1bea04a219d15169c90483eb77`,
  and Python source SHA256
  `64759894f9d00ea45a334c2b996cde94ca5a7f13eccec4bd297e21d00ae42a6a`.
  Dependency locks and the built web inputs remained unchanged.

The earlier `e2e-rzcj91` **4/6** attempt identified a premature exact-key lookup
before admission, fixed by suspending that lookup while sending the request,
and a test transport-allowance registration before the abort had actually
failed. The allowance now requires the observed failed request. These attempts
were not retried automatically; the suite keeps zero retries and its existing
case/global timeouts.

Fresh desktop and phone captures show ready, running with committed counts and
settled completion. The synthetic progress image is included in the Discovery
guide. Web type/boundary lint, scoped Python lint, production build and docs
build/link/redirect checks passed. Source review additionally covered delayed
reconciliation and workspace-incarnation changes; those specific races were
not separately runtime exercised here. The full 60-case hosted qualification
belongs to the pushed PR checks. This bounded proof does not close the separate
source-credential isolation finding #1469 or qualify a release.

### Search workspace layout correction — 11 November 2026

The shared Search workspace now places its explicit launch and readiness before
preference authoring, uses compact ordinary settings, and gives each retained
contextual tool an independent disclosure. The old Discovery form layout depended
on an ancestor absent from the new composition; this caused oversized controls,
poor grouping and duplicate settings editors. The repair changes presentation,
not search admission, autosave authority or source execution.

The final affected Search preferences journey passed **1/1** in `e2e-RUIxND`
(38.5 seconds for the case; 53.572 seconds total). It additionally checks launch
placement at 1643, 1440 and 390 pixels, collapsed draft retention, suggestion
action bounds, and a runtime draft saved after ordinary posting-age autosave
without overwriting hidden canonical fields. Saving still starts no search.

The 26-surface/four-width journey passed **1/1** in `e2e-KrCmcQ` (104 settled
captures; 26.4 seconds for the case; 42.642 seconds total). Both runs used the
same final web bundle, SHA256
`5b463cacf96cd1eaf635da540d42476bd0c0dcffad697b7f2ced9dabbdc0e562`,
with unchanged source/build inputs and dependency locks. Web type/boundary
checks passed. Desktop and phone screenshots were inspected, including the
opened contextual tools and suggestions card; document-overflow checks alone
had missed that card's original internal clipping. The refreshed guide image
comes only from the owned synthetic surface journey.

These focused passes do not replace the complete hosted suite for the pushed
head. Separate live operational verification exposed a combined-board failure
when ZipRecruiter authorization is absent; LinkedIn alone completed through the
normal application flow. [Issue #1469](https://github.com/ebarti/JobCtrl/issues/1469)
owns source failure isolation and actionable credential readiness. That backend
finding remains open and is not fixed by this layout correction. Private search
criteria, results and runtime artifacts are excluded from this record.

### Original redesign inventory — 11 November 2026

The original redesign inventory at the qualification below had **57 journeys in 25 spec files**: 56 Python
application journeys and the existing offline-demo journey. It retains the
previous 48 cases and adds the nine below. Expanded assertions inside existing
cases do not count as new cases. This is an inventory of authored coverage,
with observed qualification on `88e97a53d` recorded below. The later Materials
visual repair has its own affected proof; hosted qualification of the exact
delivery commit is tracked in the [PR checks](https://github.com/ebarti/JobCtrl/pull/1467/checks).
Neither a listed case nor a focused pass substitutes for that scope distinction.

The limits are unchanged per invocation: one worker, zero retries, 90 seconds
per ordinary case, 150 seconds for the existing demo, 60 seconds for fixture
setup and a 720-second global cap. Hosted CI schedules this inventory in two
shards as recorded below; the ordinary unsharded command retains the same cap.
Existing action/navigation/assertion deadlines
also remain. A focused pass, screenshot inventory, test listing or static check
cannot qualify all 57, and earlier failures remain part of the evidence.

| Added journey | Authored assertions and boundary |
| --- | --- |
| [Appearance](../../../apps/web/e2e/journeys/appearance.spec.ts) | Exercise all ten color and ten font choices through the UI, verify actual font loading and persistence, restore Graphite + Geist, and compare the real Plate document geometry and accepted PDF bytes before/after. App presentation cannot change the document template or accepted export. |
| [Jobs attention](../../../apps/web/e2e/journeys/jobs-attention.spec.ts) | Preserve deliberate inactive-source intent while showing quarantined or repeatedly failing sources as actionable. Inspect actual saved registry state and model/action counts; viewing attention cannot enable or rewrite sources. |
| [Profile workspace](../../../apps/web/e2e/journeys/profile-workspace.spec.ts) | Exercise peer sections, individual role/summary/date/skill/education fields, canonical saves/reload, exact wording proposals and decisions, and role/achievement remove/restore with original IDs and retained history. UI recovery, not direct database reconstruction, must preserve drafts and accepted work. |
| [Whole-product surfaces](../../../apps/web/e2e/journeys/redesign-surfaces.spec.ts) | Load 26 retained surfaces at 1440 × 1000, 1860 × 1227, 2943 × 1227 and 390 × 844: 104 settled captures within one journey. Check mounted navigation, headings, meaningful loaded/explicit-empty content and page overflow, plus real saved-material search/clear/state, control geometry and Plate/PDF access. This does not judge visual craft: earlier passing inventory checks still exposed inner Profile and Materials control defects during image inspection. |
| [Requirement associations](../../../apps/web/e2e/journeys/requirement-associations.spec.ts) | Create/revise/remove/restore many-to-many user intent through the real library/Profile flow. Keep exact requirement/source/optional-wording pins, stale history, achievement-based grouping and selected/filter/return context. Manual links never create assessment, coverage, score or model work. |
| [Search preferences](../../../apps/web/e2e/journeys/search-preferences.spec.ts) | Enter adds/focuses independent role inputs; save/reload canonical targets and source/limit settings; make no lookup while typing. Explicit controlled Photon results bind exact row/place identity, duplicate display labels remain independent, edits clear stale bindings, and invalid responses remain unverified. Deliberate search retains its saved Profile-version fence. |
| [Search assessment and recovery](../../../apps/web/e2e/journeys/search-assessment.spec.ts) | Ordinary search continues from canonical acquisition into initial person fit with separate source/assessment outcomes. Explicit saved-ID assessment performs no new acquisition. Reject foreign evidence, preserve accepted scores/manual refresh, retain failed jobs across actual worker replacement, seal cancellation without inventing model usage, and assess jobs retained by failed sources. |
| [Settings workspace](../../../apps/web/e2e/journeys/settings-workspace.spec.ts) | Save a budget before model setup, retain another pane's invalid draft, distinguish configured/unverified readiness and probe providers only on explicit request. Exercise real revision conflicts, uncertain acknowledgements and credential leave/discard protection without changing unrelated saved policy. |
| [Maintained-assignment race](../../../apps/web/e2e/journeys/wording-assignment-integrity.spec.ts) | Hold the external grouped determination for a manual Fit refresh, change an unrelated maintained assignment through its public write, and require the admitted whole-Profile fingerprint to refuse stale publication. Preserve accepted score/assignment state and the original bounded operation rather than absorbing the concurrent change. |
| [Composition freshness](../../../apps/web/e2e/journeys/wording-assignment-integrity.spec.ts) | Read job-relevant maintained-wording freshness, including missing-to-present changes; unrelated requirement assignments do not stale composition. Relevant changes preserve draft/accepted pointers and actual accepted PDF bytes. Baseline follows Profile freshness without borrowing Fit authority, and reads dispatch no model or preparation work. |

The retained cases also expand these boundaries:

- **Profile concurrency and browser recovery:** independent writer tabs, stale
  exact approval, pending-wording revision conflicts, explicit restore/discard,
  storage/ownership failures and version-fenced recovery. Non-secret version-2
  patches exclude saved/unsaved credential values; secret edits stay in scoped
  session memory, warn before reload/close and cannot be silently cleared by a
  safe restore. An unresolved copy pauses competing editing. Native invalid-form
  and application-console errors remain failures, not allowed transport noise.
- **Preparation, Jobs and applications:** the shared mode + Prepare task,
  first-Profile setup returning to the selected job/mode/comparison context,
  fresh Default column order, retained custom layouts, and actual one-request
  admission recovery. Genuine first-party writes are forwarded; only their
  acknowledgements are severed for uncertainty tests. Rehearsal/approval and
  external-send intent retain their existing authority.
- **Matching and tailoring:** direct current-assignment reuse, full supported
  achievement groups, source-bound consolidation and exact replacement lineage,
  approval alone making no Fit change, atomic current activation and accepted
  PDF preservation. Fixed operation inputs, caps, cancellation and worker-restart
  checks remain; a covered historical relation alone cannot skip current-choice
  reconciliation.
- **Offline demo:** the actual consent Worker/D1 and browser-local bundle now
  exercise peer Profile edits/reload, proposed wording review, unassessed
  requirement-link remove/restore, search input focus/persistence, unavailable
  map lookup and appearance persistence/explicit reset. Real Plate editing,
  accepted PDF bytes/text/render, reset cancellation/confirmation and consent
  retention remain. No product `/v1` request, model call, unexpected external
  request or authored-text telemetry leak is admitted. Synthetic teaching
  examples do not become semantic determinations or live-provider proof.

The observed records below distinguish complete-run results from affected
follow-up proof. The [whole-product ledger](../../plans/2026-11-11-original-app-redesign.md)
tracks acceptance and inherited/source-only boundaries separately. No
participant, accessibility-certification, installed-release or deployment
result is inferred from these source-built journeys.

The first combined attempt, `e2e-3003zl` on `8fef91a6c`, finished **55 passed /
2 failed**. An obsolete Jobs-filter selector needed a harness correction; the
managed Applications preparation wrapper also caused real 897-pixel overflow
at the 390-pixel viewport. Those failures remain part of the record. Final
combined qualification then used repaired candidate `88e97a53d`, with the same
57 cases, caps, one worker and zero retries. The first run recorded
7.662 seconds for the build, 450.418 seconds for journeys and 459.781 seconds
total. Passing Profile/Resume captures
from that attempt do not turn its failed whole-product surface case into a pass.

### Source qualification on 88e97a53d

`corepack pnpm e2e` on `88e97a53d` passed **57/57** in `e2e-0S91Lx`: 56 real
Python application cases and the browser-local demo. The actual result record
contains 57 passed bodies at retry zero, with no skips, flaky results,
unexpected results or global errors. The macOS arm64 runner had 12 CPUs and
Node 22.21.1. Snapshotting took 161 ms, composition preflight 1,606 ms, web build
7,782 ms, journey orchestration 441,372 ms and the complete command 450,971 ms.
Dependency locks and built web assets stayed unchanged during the run.

| Recorded boundary | SHA-256 |
| --- | --- |
| Frozen Python package | `745b47421cf6d3a6e006198e1a162612311401447aaf3a78958584a34bbe9194` |
| Runtime capability policy | `7d360eeba42582a39895f98b5596eaf26621be4b8061fc3067918cd33dafa8fd` |
| Combined Python/policy snapshot | `064930cce00cd0bcd34c21761b7e7cd54f9b3317339f762e5203c86dc41bc1a0` |
| Web build | `9d21a18fa51fa7177cd1125a668302a93eddb6a9568cc02d81f306b3d9fe340d` |

The whole-product matrix case passed in 26.4 seconds, producing all 104 settled
viewport captures plus full-height Profile/Requirements evidence. The repaired
Profile concurrency/CRUD and current-wording journeys passed in the same full
run. Actual baseline/job Plate, registered PDF preview/download, accepted-byte
preservation, manual requirement association, grouped assignment integrity,
search/preferences and Settings behavior were exercised under the boundaries
listed above. Source-bound model replies test authority and failure handling;
they do not measure semantic accuracy or prove live-provider compatibility.

Image inspection still found a Materials defect after that automated pass:
at 390 pixels, its search input was 24 pixels wide and its button was clipped.
Page-level overflow checks had not detected it. Candidate `fcf9e7f09` contains
the bounded class/CSS repair and strengthens the existing matrix case with
actual material search/clear, state preservation and control geometry. Its
affected run `e2e-fGjTmn` finished **2 passed / 1 failed**: production
baseline/export and demo Plate/PDF passed. The matrix's real search, clear,
filter and geometry checks passed, then an unscoped `Accepted` assertion
matched the native option plus mobile/hidden-desktop badges. The harness
correction scopes status readback to the visible Materials list and exact
select value. No production repair was added
for that assertion failure. This adds no new case, retry or time allowance.
The affected web build SHA-256 is
`b1365861bcdb3983eafba5c7949de7be6d47faaf31741db8708dc7c01f24dabf`.
The final matrix command, `e2e-imUbCE` on `8a917b23f`, then passed **1/1**:
all 104 frames plus actual Materials search/clear/status/geometry. The case
body took 25.4 seconds, with a 7,592 ms build, 30,975 ms journey orchestration
and 40,251 ms total. There were zero retries, skips or global errors. The web
hash above was unchanged from the baseline/export and demo Plate/PDF passes;
the final E2E tree SHA-256 was
`af436bc46299a4222cf7f710484a2bf50fed33b9549029c273c34b6d7e34f078`
before and after the command. The three affected cases have passing
observations across two commands, while the failed first matrix attempt remains
recorded separately.
The full 57-case result above remains attached to `88e97a53d`; hosted checks own
all 57 on the exact final delivery commit.

Independent `ps`/`lsof` corroboration passed for `e2e-0S91Lx`: all 56 recorded
initial workers were absent, all 56 recorded API ports had no listener, and
all 56 owned workspaces and 56 isolated homes were removed. This supplements
the harness's strict process-group close and teardown checks. The final
`e2e-imUbCE` worker and API port, its two log-derived ports and all owned process
paths were absent; successful workspaces/homes and Temporal state were removed.
The failed `e2e-fGjTmn` attempt had both workers absent, both API ports and four
log-derived ports closed, and no owned process-path match. Its one synthetic
workspace/home and one Temporal history directory remain deliberately retained
for diagnosis; its demo home was removed. These are actual `ps`/`lsof` checks
of run-owned resources, independent of the harness teardown. Temporary synthetic
evidence stays outside the repository;
published screenshots contain synthetic state only. Agent image review and
these browser checks do not establish participant usability, a full accessibility
audit, a new installed/native qualification, release or deployment.

### Hosted scheduling follow-up

Hosted [CI run 43031016511](https://github.com/ebarti/JobCtrl/actions/runs/43031016511)
on `79bf88b814ec34d546418fa784833aba21b5c78c` did not qualify the full suite.
Ten other jobs succeeded, while the
[Browser job](https://github.com/ebarti/JobCtrl/actions/runs/43031016511/job/130557875712)
hit the unchanged 720-second global deadline. Its actual result record has
56 passed application cases, one case that did not run, zero individual case
failures and global suite/teardown deadline errors. The demo did not complete,
so this is a failed complete-suite result, not 57/57. The Linux x64 runner had
four CPUs and Node 22.21.1; build, journey orchestration and total were 18,534,
721,079 and 744,757 ms. The web SHA-256 remained
`b1365861bcdb3983eafba5c7949de7be6d47faaf31741db8708dc7c01f24dabf`.
This hosted observation is separate from the successful local 57/57 and affected
proof above.

The scheduling correction partitions the same complete inventory with standard
Playwright `--shard=1/2` and `--shard=2/2` on two independent runners. Each
invocation uses one worker and zero retries, with the existing 90-second case,
150-second demo, 60-second fixture and 720-second global limits. Existing
action/navigation/assertion deadlines, the 14-minute journey step and the
20-minute journey job stay unchanged.
Each shard checks out the same candidate, builds once, owns its application and
Temporal processes, and retains evidence under a unique shard/run-attempt name.
Artifacts use `python-application-journeys-shard-N-of-2-<run_attempt>` with the
same scoped paths and seven-day retention.
Matrix fail-fast is disabled. The always-evaluated **Browser / UI checks**
aggregate passes only when `needs.shards.result == 'success'`; a failed,
cancelled or skipped shard cannot qualify the suite. This changes scheduling,
with no removed case, new retry, larger deadline or application/harness behavior
change.

Native Playwright JSON listing measured shard 1 at **35 cases / 13 files** and
shard 2 at **22 cases / 12 files**, including the demo. Their union is exactly
the full **57 cases / 25 files**, with zero overlap, missing cases or extras.
This is partition-inventory proof, not executed shard qualification. YAML
parsing and the aggregate's actual shell truth table passed: `success` exits
zero; `failure`, `cancelled`, `skipped`, empty and unknown values exit one.
At this record, hosted qualification is pending; final results are
tracked in the [PR checks](https://github.com/ebarti/JobCtrl/pull/1467/checks).

#### Hosted APT setup blockage on 7aca2507

Attempts 1 and 2 of
[CI run 43035593774](https://github.com/ebarti/JobCtrl/actions/runs/43035593774)
on `7aca2507cd4ba8ccf21ae8a716588f20e75af8bc` were blocked during dependency
setup. Eight non-APT gates passed; Linux credentials, Support's rendered-docs
setup and both Browser shards failed on temporary DNS resolution errors for
`archive.ubuntu.com`, within the unchanged five-/eight-minute setup caps.
**Zero browser journeys ran in either attempt.** The Browser aggregate correctly
failed. One bounded rerun of failed jobs reproduced the same setup blockage;
this was a workflow-job rerun, with no test retries or executed-case pass claim.

Support's documentation build passed in both attempts:
[attempt 1](https://github.com/ebarti/JobCtrl/actions/runs/43035593774/job/130573745224)
in 19.72 seconds and
[attempt 2](https://github.com/ebarti/JobCtrl/actions/runs/43035593774/job/130579230044)
in 22.30 seconds, each resolving 16,171 references across 473 emitted files.
Those builds do not qualify the rendered-docs check that dependency setup
prevented. The successful local 57/57, affected proof and earlier 720-second
hosted suite timeout retain their original candidates and scope.

The CI-only diagnostic follow-up extends `scripts/ci-apt-timeouts.sh` with an observational
preflight on the affected runner, under one 25-second diagnostic deadline.
Six normal-user/`_apt` DNS probes and three bounded GET probes to the same three
existing mirror URLs run in parallel, with a fixed whitelisted effective APT
query and proxy-presence flags only. This changes no network/trust configuration,
mirror selection, installed package, existing setup/test cap, retry policy,
application or test. These observations do not establish a DNS repair or
passing hosted qualification; final results remain in the PR checks.

#### Conditional transport recovery after 1d79df1b

[CI run 43040489820](https://github.com/ebarti/JobCtrl/actions/runs/43040489820)
on `1d79df1ba719a5513df6cc5ca204bf2cf34b405c` again passed eight other gates
while all four APT-dependent jobs failed before runtime tests. The Browser
aggregate failed and **zero browser journeys ran**. Each affected job recorded
all six normal-user/`_apt` DNS probes hitting their five-second deadline and
being killed (raw return code `-9`). All three original
mirror GETs exited `28` after about five seconds, with HTTP `0` and DNS/connect
timings `0`. Effective APT transport was 15 seconds/one retry and proxy-presence
flags were false. These observations locate a timed-out transport boundary;
they do not establish a completed DNS answer. Support's
[docs build](https://github.com/ebarti/JobCtrl/actions/runs/43040489820/job/130593630400)
passed in 17.76 seconds, resolving 16,171 references across 473 emitted files;
its rendered check remained blocked.

The conditional transport candidate is the fixed HTTPS endpoint
`https://mirrors.edge.kernel.org/ubuntu/`.
[Ubuntu's package-download page](https://packages.ubuntu.com/noble/all/pppconfig/download)
lists its parent `mirrors.kernel.org/ubuntu`; the
[operator's index](https://mirrors.kernel.org/) lists Ubuntu and the
[HTTPS parent](https://mirrors.kernel.org/ubuntu/) redirects to that edge
endpoint. This is Ubuntu-listed/operator-verified provenance; Launchpad
registration was not verified. Four local Noble `InRelease` GETs returned HTTP
200, which proves neither signature verification nor hosted reachability.

The recovery may prefer that candidate only when exactly three parsed,
completed original HTTP results are failed and the candidate's bounded Noble
`InRelease` GET exits zero with HTTP 200. Any exit-zero original response in
HTTP 200–399, including a redirect, or any indeterminate/missing/malformed
result retains the originals. The candidate GET has five-second connect and
eight-second total limits, with zero retries. Promotion appends only the fixed
HTTPS candidate at priority zero to a regular, nonsymlink mirror file; original
bytes remain and unexpected state refuses promotion. All original mirrors,
suites, `Signed-By`, keys, signature/hash/freshness checks, setup/test caps and
required cases remain. Actual APT installation and every
required test gate must still pass. At this record, hosted recovery is
unqualified; final results are tracked in the PR checks.

#### Hosted shard execution and tailoring cleanup on ebc0f07f

Attempt 1 of [CI run 43044610890](https://github.com/ebarti/JobCtrl/actions/runs/43044610890)
on `ebc0f07f30df14d5e1dd289fc08dd8d30e336b92` passed ten non-Browser gates,
including Linux credentials and Support's actual rendered-docs check. Browser
setup ran zero journeys: the candidate HTTPS connection phase timed out at
five seconds after DNS/TCP completed, so fallback was not admitted. One
failed-job-only rerun on the unchanged head then executed both shards:

| Attempt 2 job | Result | Build / journeys / total (ms) | Artifact ID |
| --- | --- | --- | --- |
| [Shard 1](https://github.com/ebarti/JobCtrl/actions/runs/43044610890/job/130612880917) | 35/35 passed | 14,142 / 289,235 / 306,069 | `13868441385` |
| [Shard 2](https://github.com/ebarti/JobCtrl/actions/runs/43044610890/job/130612880579) | 21 passed / 1 failed, including a passing demo | 22,568 / 465,932 / 493,224 | `13867457966` |

The combined result is **56/57**, with zero Playwright retries, skips, flaky
results or global errors. The tailoring case reached its final product
assertions and `full-baseline-approval` attachment, then failed in cleanup with
two `route.fulfill: Route is already handled!` errors; its body took 13.080
seconds. It remains a failed case. Review of pinned Playwright 1.64.1 traced
handler removal automatically continuing a pending route before the test's
forwarding-read callbacks had drained.

The test-only repair uses `page.unrouteAll({ behavior: "wait" })` to finish active
callbacks before removing server interception, retaining the tracked-read drain,
all assertions and error propagation. Its actual affected journey passed **1/1**
in `e2e-H9YSIC`: body 6.4 seconds; build/journeys/total 8,404 / 12,728 / 22,914 ms,
with zero retries, skips or global errors. Production Python/policy/web hashes,
dependency locks and built assets stayed unchanged. The repaired E2E tree SHA-256
was `7194a27dbd47d258fe778671777bd68390f4a9e5643c2c08e4718c7a0e3f4b30`.
This focused pass does not establish 57/57 on the repaired head; full hosted
qualification remains tracked in the PR checks.

#### Hosted application pass and demo navigation follow-up

[CI run 43050218151](https://github.com/ebarti/JobCtrl/actions/runs/43050218151)
on `2d1d0b6ccb903cf989476849e50f62c46b27dfd8` executed all 57 cases once.
[Shard 1](https://github.com/ebarti/JobCtrl/actions/runs/43050218151/job/130625075305)
passed 35/35 (458.911 seconds journeys / 488.045 total);
[shard 2](https://github.com/ebarti/JobCtrl/actions/runs/43050218151/job/130625075460)
passed 21/22 (342.911 seconds journeys / 361.941 total). All 56 application
cases, including repaired Tailoring, and all ten non-Browser gates passed.
The overall result remained **56/57**, with zero retries, skips, flaky results
or global errors; the Browser aggregate correctly failed.

Trace review localized the sole demo failure to selecting Tailored on the
outgoing Applications page while the guide's Job details navigation was still
in flight. The test-only correction waits for the exact job URL and Job details
main, then scopes the mode/buttons there, retaining all assertions. Its actual
focused demo passed **1/1** in `e2e-PSTRGE`: body 29.0 seconds, build/journeys/total
8,404 / 40,328 / 50,551 ms, with zero retries, skips, flaky results or global
errors. Complete Plate/PDF/reset/privacy checks passed and owned cleanup was
independently corroborated. Production hashes, locks and assets stayed unchanged;
the E2E tree was `dd8f08ce8417337be4d6a20c3b4b6faa434a6f037ef6e8c9dd96c966eaa4b6b8`.
This is affected proof, not 57/57 on the corrected head; full qualification is
tracked in the PR checks.

#### Hosted Profile reload error classification on dfde0c08

[CI run 43052989422](https://github.com/ebarti/JobCtrl/actions/runs/43052989422)
on `dfde0c08def60644b6058e2095d5c95e4b615a7f` executed exactly 57 cases in
25 files: **56 passed / 1 failed**, with zero retries, skips, flaky results or
global errors. [Shard 1](https://github.com/ebarti/JobCtrl/actions/runs/43052989422/job/130635023746)
passed 35/35 (456.712 seconds journeys / 483.223 total);
[shard 2](https://github.com/ebarti/JobCtrl/actions/runs/43052989422/job/130635023937)
passed 21/22 (405.229 seconds journeys / 427.139 total). Tailoring and demo
passed; the Browser aggregate correctly failed.

The sole Profile failure rejected a 20-second `TimeoutError` because its abort
regex accepted only other reload-error forms. The old trace showed a real
`beforeunload` prompt, dismissal acknowledgement, no document request and exact
unsaved text still visible; it did not directly measure Document identity.
The reviewed test-only correction captures the real Document before typing,
awaits dismissal and requires same-Document/editor/durable-text proof before
accepting a known abort or concrete `TimeoutError`; unguarded errors and failed
dismissal rethrow. Subsequent reload and all recovery/CRUD assertions remain.

The whole Profile journey passed **1/1** in `e2e-Ew1NjA`: body 5.2 seconds,
build/journeys/total 8,609 / 11,285 / 21,566 ms, with zero retries, skips or
global errors. Its attachment observed **prompt-free ordinary navigation**
(`promptCount: 0`), validating ordinary reload/recovery and full Restore/Undo/save/CRUD.
The new guarded-timeout branch is source-reviewed and was **not runtime
exercised by this local run**. Production hashes/locks stayed unchanged and
independent owned cleanup passed. The E2E tree was
`cc06ad98d5fb6f391e5bfe64f2e4f6c2619d5ea577984d306edef5017aa5b824`.
Full corrected-head qualification remains tracked in the PR checks.

### Matching walkthrough and user guides — 11 November 2026

The documentation/demo follow-up to `7ebd3da987c802256611130d33b03854cb873cdb`
passed `corepack pnpm e2e -- --project=demo-chromium` **1/1** in `e2e-Jj7zOl`.
At that candidate, this extended the existing demo case and the inventory
remained 48 journeys with unchanged budgets and zero retries; the current
redesign inventory is recorded above. The macOS arm64 runner had
12 CPUs and Node 22.21.1. It recorded 174 ms snapshot, 1,602 ms preflight,
7,797 ms build, 20,300 ms journey orchestration and 29,912 ms total. The test
body took 9.1 seconds. Python, runtime-policy and source-candidate hashes match
the full-catalog qualification below. The new web build SHA-256 is
`581d63547e0ccff14d514a146fd1386bbfd426e5cb7c3406f1cc431155f92d5b`.
Build files and dependency locks remained unchanged during the run.

The real demo bundle, consent Worker and browser exercised all four illustrative
matching steps, both edit examples, completed/stopped/partial outcomes, grouped
wording and approval/deferral examples. Keyboard entry, modal containment,
Escape/close focus restoration, reopening and example reset passed. Profile
fields, run identities and simulation receipts were unchanged by the walkthrough;
the actual model-backed update remained unavailable. The retained resume edit,
exact wording approval, reload, accepted PDF bytes/text/render and artifact
catalog also passed. Cancelling the real demo reset preserved the edit;
confirming reset restored synthetic seeds without resetting consent.

There were no product `/v1` requests, unexpected external requests, authored-text
leaks or browser errors. Owned runtime cleanup was corroborated by process and
listener checks. Desktop 1440px and mobile 390px dialog captures were inspected,
including both scroll positions of the dense two-requirement wording example.
The full-page opening-fade capture is not used as settled visual evidence.
The walkthrough is a fixed teaching example, not a model determination or a
replacement for the real Python qualification journeys.

The first mobile assertion sampled the existing 150 ms `max-width` transition
immediately after resizing. Computed styles established the interpolation;
normal retrying full-viewport visibility followed by the same geometry bounds
passed with unchanged production sizing. A separate reload assertion was
corrected to the existing in-memory guide preference: reload returns to the
launcher while durable demo data remains. Neither repair added sleeps, retries,
timeouts or new production persistence.

Frontend type/boundary checks passed with zero violations. The documentation
build resolved 15,941 references across 477 emitted files, and the fresh browser
runtime check passed in desktop/mobile and light/dark configurations. Its first
run exposed a stale expectation for the retired 45/30/25 dimension fallback;
the gate now checks the actual scoped requirement policy and refuses that old
current-behavior claim. The same formula/credit/headings and other runtime gates
remain. Source review is clear. This evidence qualifies the source-built guide
and demo, not a hosted deployment or the pending whole-app redesign.

### Full catalog matching and manual refresh — 10 November 2026

The complete source command `corepack pnpm e2e` on
`a7e5c73b99f245452f1b12885dcee6d56080f2a8` passed **48/48** journeys in
`e2e-FcYpDn`: 47 Python application journeys and the browser-local demo. There
were no retries, skips, unexpected or flaky results. The macOS arm64 runner
had 12 CPUs and Node 26.13.0. It recorded 124 ms source snapshot, 1,714 ms
composition preflight, 7,248 ms web build, 303,063 ms journeys and 312,187 ms
total. The dependency locks and built web assets remained unchanged.

The source candidate SHA-256 was
`55ef63c80afde9a06fc87d5d52ceca11b52cfcbc5aa418adac4531c28d360a28`;
the frozen Python package SHA-256 was
`48db340635bc11f9f3ad16c54a0a7b4cd88b4eb95046992c60a74a17f848b590`;
the web build SHA-256 was
`4cf2c179631e8b1ef5c0c6c0e66b3349c8721246eb7769e52fe5b578598ac099`.

The added journeys verified complete-catalog matching and strict response
validation, unchanged reuse, formerly missing support after a factual edit,
one grouped proposal for an achievement's requirement set, explicit approval,
fixed job scope, duplicate admission, cancellation, source changes while queued
or running, and durable limits across an actual worker replacement. The
uncertain-authoring journey preserved both original attempts, retried only
achievement A, kept B visibly pending, then retried B through the UI. Forged
retry metadata caused no model call. A fresh workspace kept its saved Profile
version null, returned the minimal `profile_required` readiness response, and
created no passive refresh action or model call.

The earlier full run `e2e-66BMJV` passed 44/46 and exposed two real regressions:
the new pending read returned 404 in valid Discovery and Compensation workflows
before Profile creation. The Fit-owned readiness response repaired both. A
separate real-demo Profile visit exposed an existing preview HTTP path/query
contract error; the caller was repaired while retaining the Plate editor.
The final full run includes both repairs and the demo capability guard. Earlier
failures remain diagnostic evidence, not passing qualification.

Desktop and 390px screenshots of ready, running, completed, uncertain-wording,
subset-retry, pre-Profile and demo-unavailable states were inspected. The
synthetic journeys exercised actual HTTP, Temporal, worker processes, SQLite
and rendering; only external providers were controlled. They do not establish
real-provider semantic quality, a hard monetary cap, model token-context
capacity, or installed-release behavior. Independent source review found no
remaining scoped findings after recovery, source-fence and lineage repairs.
The delivery record is [#1464](https://github.com/ebarti/JobCtrl/issues/1464)
and [PR #1465](https://github.com/ebarti/JobCtrl/pull/1465); the broader visual
redesign remains separate.

After that full run, the setup link gained only an underline. The real
pre-Profile journey passed again in `e2e-iJW9Mr` (1/1, 15,808 ms total), with
unchanged Python sources and locks. Its web SHA-256 was
`2e741d704d11542302f7e8a8a888df28a7852d763a612be36d3e8c97c1e99391`.
The revised setup screenshot was inspected; the final combined candidate's
hosted results belong to the PR checks.

The first hosted run on `6d876ff9e`,
[CI 42917881590](https://github.com/ebarti/JobCtrl/actions/runs/42917881590),
passed ten jobs but did not qualify the browser suite: its 480-second aggregate
deadline stopped execution after 40 passed cases and left eight incomplete.
There was no assertion failure; the next case was interrupted during setup.
For the same 39 completed cases, workspace startup took 295,485 ms versus
185,094 ms in the earlier hosted run, while test bodies took 141,025 ms versus
112,854 ms. Web build time also rose from 14,957 ms to 24,181 ms. Startup
continued steadily (7.79 seconds median, 8.28 seconds maximum), rather than
stalling in one journey.

Those measurements project roughly 610–630 seconds for all 48 cases on the
slower runner. The aggregate suite allowance is now 720 seconds, with a
14-minute CI build/suite step and the existing 20-minute job limit. This leaves
bounded room for composition, build, teardown and evidence collection. The
90-second ordinary test, 150-second demo and 60-second fixture limits, one
worker, zero retries, assertions and owned-process cleanup are unchanged.
This is a measured harness-budget correction; the timed-out run remains
non-passing, and product behavior was not changed to accommodate it.

The subsequent [CI run on `7ebd3da987c802256611130d33b03854cb873cdb`](https://github.com/ebarti/JobCtrl/actions/runs/42920853796)
passed all 11 jobs. Its [Browser job](https://github.com/ebarti/JobCtrl/actions/runs/42920853796/job/130195135601)
passed **48/48** journeys on Linux x64, four CPUs and Node 22.21.1. The run
`e2e-PcNdAV` recorded 328 ms snapshot, 3,825 ms preflight, 21,815 ms build,
612,612 ms journeys and 638,664 ms total. The Python source hash matched the
complete local run; the web hash matched the underlined-link follow-up above.
Build files and dependency locks remained unchanged. This qualifies that source
candidate, not a later documentation/demo revision or a hosted deployment.

The Product Tour's `affected-matches.png` is the unchanged desktop-ready capture
from `e2e-FcYpDn`, inspected at its original 1440 × 1000 size. Its Profile fields
are synthetic. It shows the implemented source-build control and its saved-input
warning, not the proposed whole-app redesign. The image is an illustration;
the journey results above establish the exercised behavior.

### Earlier transformation qualification

The hosted [Browser job](https://github.com/ebarti/JobCtrl/actions/runs/42289605507/job/128139371277)
on candidate `09f9d5c` passed **23/23** source journeys, including the demo, in
`e2e-DUQtlZ`. Its Linux x64 runner had four CPUs and Node 22.21.1. It recorded
3,524 ms composition preflight, 20,738 ms web build, 314,112 ms journeys and
338,686 ms total; the lockfiles and web build remained unchanged. Its frozen
Python source SHA-256 was
`aa0464efab513542ad7446a06eea2e9e8927bcaf530c8ec21daeaf36fe367051`.
A passing Browser job does not establish the final result of the other hosted
jobs or of a later candidate.

The latest installed application run `e2e-kGHZtb` passed **22/22** Chromium
journeys with zero skipped, unexpected or flaky results and no retries. It used
an extracted unsigned minimal application payload on macOS arm64 / 12 CPUs /
Node 22.21.1, with component-lock CPython 3.12.12 and Temporal CLI 1.7.3
(Server 1.31.2). It recorded 34 ms snapshot, 1,598 ms composition preflight,
**0 ms web rebuild**, 198,682 ms journeys and **200,351 ms total**; the Python
lockfile and web build were unchanged.

The database-fixed wheel SHA-256 is
`2b238d4ffbfe5916c3b778ee016f6d12b5a5c77f789624a23f1e3fec3f2f5766`;
the whole payload SHA-256 is
`72610e9386f2768f9dddab3214577cf07e3560f85664ef3479d164eb5fa43cf8`
(8,247 files; 1,136,209,416 bytes). All 313 installed Python source files,
totaling 3,313,583 bytes, match source SHA-256
`a94f09c4962c950675a7b5b04e1ecf557647b06387db113f5f75127daae06b70`.
The 99-file, 10,597,612-byte web candidate SHA-256 is
`0b172f2c478f9d690e77aa43a3485b4e977abad3547d8460027a75ca84a1d282`.
The JobCtrl, HTTPX, Pydantic, Temporal and Playwright imports came from inside
the payload; no checkout import or source-resource fallback participated.
Preparation, source equality and import-origin receipts are retained in evidence
bundle `installed-application-_ajwp183`.
Its component-lock runtime archives were verified before extraction: CPython
`7e162bf77f6c2ecd7602960162c1b867eb61ac348863546e66db632b5731a5ea`
and Temporal `ed0357cd77aef432021556c36c3b68bfbe38b86677dd7db86575abd312dc56c7`.

The prior credential-fixed `e2e-npLcAJ` passed 22/22 in 198,714 ms journeys and
200,471 ms total using wheel
`7d34a450c18292b160d5d84e135b96aa032ff3e81eed9d713e3a9c51f44b8e93`.
The earlier `e2e-Htgt0Q` passed 22/22 in 202,126 ms journeys and 204,642 ms
total using wheel
`33d3504d3e0dd50950627ae9d3d441d1e0925156e5e4b26902f6bd6cc2ff24be`.
Both remain historical evidence for their own payloads, not the latest wheel.

The installed command is `node scripts/run-e2e.mjs --installed --project=chromium`
with `JOBCTRL_E2E_PAYLOAD_DIR`, `JOBCTRL_E2E_PYTHON`, `JOBCTRL_E2E_STATIC_DIR`,
`JOBCTRL_TEMPORAL_CLI_PATH` and `PLAYWRIGHT_BROWSERS_PATH` selecting that extracted
payload. The runner validates canonical interpreter/static/import containment
and supplies the real bundled runtime environment. The status column below
refers to the latest complete installed run unless it explicitly names the demo.

| Journey | Critical behavior replacing legacy evidence | Status |
| --- | --- | --- |
| Python boundary and committed updates | Real health/configuration, loopback auth/origin refusal, browser load and one event connection; committed mutation reaches the browser; valid-body HEAD cannot mutate canonical records/events | Passed |
| Baseline editing and recorded PDF | Every role/achievement, actual Plate edit, exact edit approval, separate draft/accepted revisions, actual PDF text and page images, historical PDF.js preview and browser-download SHA; zero model calls | Passed; source-run original and edited page images were also visually inspected without clipping/overlap |
| Approved tailored resume | Requirements vs factual Fit vs wording coverage; pending proposal and exact Profile approval; complete deterministic composition, advisory review/override, failed review/render retain accepted bytes | Passed, including failed review/render preservation and explicit override |
| Meaning authority and failed refresh | Opposing explicit model decisions, paraphrase reuse/qualified distinction, unsupported/invalid output, source mutation during inference and preserved accepted snapshot | Passed |
| Profile identity and conflicting saves | Concurrent same-revision saves admit one writer; stale exact approval refuses; actual form preserves stable achievement IDs, nested extras and literal policy values | Passed |
| Durable cancellation and restart | Hold external request, cancel via HTTP, SIGKILL actual worker, start distinct worker, inspect original run and accepted-artifact preservation; honest unknown-spend refusal followed by explicit unlimited-money policy | Passed; unknown prior accounting remains visible after replacement work succeeds |
| Application intent and uncertainty | Current factual Fit, exact prepared/rehearsed/approved payload, changed input invalidates approval, real mail POST after persisted intent, worker death, uncertain status and no second send after restart | Passed |
| Optional capabilities | Reduced composition; contact/research/Outreach review and manual-send receipt retry; Interviews/Learning/Digest recovery; Compensation/Offers evidence, unknowns and history | All eight passed |
| Extension and setup | Real pairing/rotation/capture receipt and broker lease; public setup CLI and external credential command | All three Extension journeys and setup passed |
| Composed Jobs query | Global pagination/filter/facets, saved selection/navigation and optional-module refusal | Both passed |
| Preparation admission recovery | Genuine lost acknowledgement, changed input/navigation/reload, reconcile original durable run before any new admission | Passed |
| Browser-local demo | Real demo bundle, consent Worker and D1; owned browser state, local edits/export and no Python API traffic | The isolated actual browser journey and the hosted Browser job passed; this does not establish a hosted deployment |

The first integrated source run on macOS arm64 / Node 22.21.1 recorded 6 passed
and 9 failed journeys, 8,321 ms web build, 116,226 ms journeys and 124,549 ms total;
the Python lockfile was unchanged. It exposed real first-use read-contract and
worker cancellation defects as well as selectors and missing test prerequisites.
Those failures are not a passing qualification. A later frozen candidate could
not start because it captured an incomplete cross-file Interviews refactor; it
was stopped after repeated identical startup failures, and no product assertion
ran. The composition preflight now prevents that repeated failure pattern.

The frozen full Chromium run `e2e-rCUXK8` recorded 14 passed and 7 failed
journeys: 147 ms snapshot, 1,191 ms actual composition preflight, 8,640 ms build,
253,009 ms journeys and 263,026 ms total on macOS arm64 / Node 22.21.1 / 12 CPUs.
The Python lockfile and static build were unchanged. Its Python package SHA-256
was `21cce0ff69cbfe705192034220819a8c4aeef90ae72f99f3463d6a359f3e3a50`;
the web build was `4a624f07b0a288c00c55f0afcc282a270e96540159c9e7099d0e09f65a9d5370`.
It is not a passing qualification. The table records the observed boundaries and
repairs; the new combined source/policy hash belongs to the next run.

The next full Chromium run `e2e-w989ac` recorded 18 passed and 4 failed journeys:
153 ms snapshot, 1,192 ms preflight, 8,194 ms build, 179,066 ms journeys and
188,640 ms total on the same runner. The Python lockfile and static build were
unchanged. Every original core journey passed. Its combined frozen Python/policy
SHA-256 was `0c644feb105e9c26c53e7cf8dc77731c0d3014b4d426f8a7a5918b9c6572aacb`;
the web build was `e11ea5b0acb8a6b8fc2ead26fc41e80461e6bac2a5034e0ec46f8a38a5452380`.
That source run alone did not qualify the complete suite; its remaining failures
were addressed by the focused follow-ups below and the complete installed run
recorded above.
These local source runs used the available Temporal CLI 1.9.1 / Server 1.32.0.
Both installed runs subsequently exercised the pinned CLI 1.7.3 runtime. The
later hosted Browser result is recorded above; other hosted gates remain separate.

Focused follow-up `e2e-cOQbyj` ran four journeys: optional-module Jobs refusals,
Learning recovery and Preparation recovery passed; the global Jobs journey still
failed. Its complete command took 39,849 ms (8,515 ms build, 29,921 ms journeys).
The final global Jobs follow-up `e2e-kz95to` passed in 19,475 ms total (8,539 ms
build, 9,646 ms journeys) with web SHA-256
`0b172f2c478f9d690e77aa43a3485b4e977abad3547d8460027a75ca84a1d282`.
Both used the same frozen Python/policy hash above, and their locks/static builds
were unchanged. At that stage, the 22 Chromium journeys had passed across the
full and focused evidence, but not in one source run. The later hosted Browser
job above subsequently passed all 23 source journeys, including the demo.

The isolated demo run `e2e-tNQ809` passed one journey with the real consent Worker,
D1 and compiled demo bundle. Its isolated demo build took 8,101 ms, demo setup
10,196 ms and complete command 23,691 ms. The generated PDF was downloaded,
read back as text and inspected as page images. This is demo qualification and
does not replace a hosted deployment proof.

The installed result qualifies these recurring application journeys against the
tested minimal payload. That payload was unsigned and did not install provider
packs; its assembly metadata explicitly records
`fullDistributionClosureQualified: false`. It does not qualify signed/notarized
acquisition, the complete release distribution, published-predecessor lifecycle,
or live model authentication, quality and pricing.
The controlled external replies establish application validation, authority and
recovery behavior; they do not grade a live model's semantic determinations.
Authored assertions and separate owner probes do not replace those remaining
entrypoint/platform proofs.

Legacy suites include Python unit/isolated workflow tests, Fastify/API/RPC
contract tests, Vitest component/hook/type tests, snapshots, fixture-seeded
Playwright suites, script contract tests and Go unit tests. Their retirement is
part of this transformation. Static checks, builds, privacy checks and source
architecture checks remain. The ledger above preserves the required outcomes;
it does not claim every historical test case has equivalent recurring coverage.

## Separate operational evidence

Full old-to-new Profile transfer is a one-off synthetic integrity proof and is
outside the recurring suite. Installed launch/stop/restart, signed acquisition,
native credential stores, platform filesystem permissions, actual extension
installation and real provider authentication/model changes require their real
entrypoint/platform proofs before release. On the original PR candidate `0db`,
the other hosted contexts passed, including Backend job `128144844565` and
Browser job `128144844490`; Windows credentials was the exception. The Windows
fresh-database startup `OSError` (`errno 9`) came from flushing a read-only
staged database; the fix opens the staged file writable for that flush.

The repaired Windows [credential job](https://github.com/ebarti/JobCtrl/actions/runs/42291768416/job/128146721619)
on `23bafd876` passed 37 controlled and 21 native checks with cleanup confirmed;
the same focused workflow also passed Linux and macOS credential qualification.

The final native first-selection proof passed in **32,683 ms**: actual public
full Profile transfer and readback, compiled installer selection, native
start/stop/restart, complete-pair reinstall, and refusal of a used transfer with
missing history under another runtime home. All 19 receipt, ownership, partial
pair, registration and schema refusal controls passed. Unknown/legacy application
identities and versions preserved the entire workspace inventory. A current-header
metadata refusal retained the canonical database, receipt and selection, while
explicitly recording SQLite's inspection-only WAL/SHM companions. Eight owned
processes exited, receipts retired, fixed ports were free, and the unrelated
control survived until cleanup through its own handle.

This is owned unsigned native integration evidence, not signed predecessor
qualification. The launcher and installer SHA-256 values are
`db290a9467e37f228689220f119ba4e4b111f1147a77b7c537f008d12f0fe6af`
and `72caa70d40bf4846da1f50db2ac488a3e9cd1cb3ca58164a478dd5a13038b34e`;
the report is `native-transfer-admission/operational-result.json` below the
task's owned temporary root. Declared-platform Go build and vet passed. The
independent release-harness review closed with no remaining scoped findings on
SHA-256 `e30abba907adcfec805c81b19b21f9560710f47e52d7b7e0531baa62a4c287a0`.

Windows Gmail and both Darwin lifecycle/custody partitions also passed hosted
on their recorded candidates. The active published-predecessor upgrade harness
uses signed-only schema-2 exact identity. Its final operational result and the
whole-head hosted checks are tracked in [#1428](https://github.com/ebarti/JobCtrl/issues/1428)
and [PR #1454](https://github.com/ebarti/JobCtrl/pull/1454); both are required before
merge. This preparation snapshot does not infer either result from earlier runs.
A controlled HTTP boundary cannot prove those outcomes. Record the exact
commands, candidate, runner, timings and
unverified gaps without inferring readiness from test deletion or a green build.

### Native Discovery accounting setup

`discovery-accounting.spec.ts` runs a fresh owned application with the ordinary
native model preflight and isolated HOME. A real worker action with a finite cap
and missing quote refuses before model execution or source acquisition. The UI
keeps Start search actionable, explains the refusal, opens contextual Budgets,
saves an explicitly synthetic exact quote, and returns to the same Jobs filters.
Assertions retain profile, provider, monetary cap and the single failed action;
no model or source request is launched after saving. Browser credential, provider
and setup-status routes are forbidden by a transport sentinel. This proves
admission and recovery UX, not real provider pricing, authentication or model
execution. Ordinary externally-accounted Discovery remains separately exercised.

Focused verification on 12 November 2026 passed the native accounting setup
(1.0 seconds) and existing Settings draft/navigation journey (3.2 seconds),
20.432 seconds total with zero retries. The ordinary saved Jobs search also
passed (2.1 seconds) in the preceding focused run. This does not claim a new
complete 66-case run or real provider execution.

### Compact multi-query source-failure feedback

Jobs groups repeated source failures for presentation by recorded source family,
board set/source identity, error code and exact message. It reports affected
query/location combinations rather than inferring unique authored-query counts
from opaque unit IDs. Search details retains every recorded failure, raw board
identity and available source/family/unit provenance. Partial or failed status,
canonical job counts, receipts and accepted jobs are unchanged.

The existing pinned-SDK provider-scope journey now runs two literal queries over
two locations. Eight recorded board failures render as two actionable notices,
four combinations each. It opens all eight detailed receipts, verifies their
IDs/codes/messages, closes and reloads the page, and reads back the unchanged
canonical failure list. Its settled 1440×1000 capture shows the table in the
first viewport. No live source request, private workspace or internal API mock
participates.

Focused run `e2e-9sFZDr` passed **1/1** on 12 November 2026: 3.2 seconds for the
case, 8.529 seconds for the runner phase and 17.364 seconds total, including a
7.491-second web build. Retries, skipped, unexpected and flaky results were zero;
web build and dependency locks stayed unchanged. The 151-file web bundle SHA-256
is `589ed43206fe9516cfc0d50f8bc36a656af3d7a86bd2a13a0f0be093292bae56`.
Frontend type and boundary checks passed with zero boundary violations.

The first focused attempt, `e2e-C44Jqm`, exposed a test-request scope mistake:
plain queries legitimately included an ATS source registered earlier in the
same case and produced a ninth independent failure. The corrected request uses
the case's explicit broad-board scope; exact receipt-count assertions remain.
The initial sandbox-only attempt stopped before any journey because loopback
listeners were denied. These attempts are retained as setup history, not passing
runtime observations. This focused result does not claim a new complete-suite,
hosted, release or deployment qualification.

### Terminal search feedback lifecycle

Last-search acknowledgement is browser presentation state, fenced by tenant,
workspace, database incarnation, run and an opaque digest of the exact terminal
action outcome. The canonical status, counts and failures remain in Search
details. Current saved board membership takes precedence over an active registry
entry when classifying historical remedies. Disabled or deselected sources keep
their old errors in details; unknown current reads remain unknown. Active work,
status uncertainty and unresolved admission recovery cannot be dismissed.

The SDK acquisition/recovery suite explicitly uses the reduced
`profile,jobs,discovery` composition; the ordinary saved-search journey owns full
initial-assessment proof. The extended existing provider-scope case verifies
deselection, dismiss, reload, Search preferences navigation and return, all eight
retained failures, restored display, a new undismissible active run, and its new
visible terminal outcome. Run `e2e-Q2nhdt` passed **1/1** on 12 November 2026:
3.8 seconds for the case, 8.171 seconds for the runner phase and 16.955 seconds
total. Retries, skipped, unexpected, flaky and browser-console failures were
zero; dependency locks and the 151-file web bundle remained unchanged. The web
SHA-256 was `03b9b25380f25163ca9c7e8b7cd9cfa0e1701404880010416e1980122b48b74f`.
The dismissed desktop capture was inspected with Show result and Search details
accessible above the table. Frontend type and boundary checks passed.

The final source-only and lifecycle checks also passed in `e2e-ebJ54I`: the SDK
case took 4.1 seconds and Companies took 3.5 seconds. A terminal result whose
canonical `preparationAvailable` is false explicitly says initial assessment is
unavailable; an old result without that flag does not invent an assessment
count or a missing-row error. The 151-file web SHA-256 was
`e77620cb4b16d59b7acd58c36f857d07a5432c0f7d230f7e84caa5cedfeffed1`.
That three-case invocation was not fully passing: its separate selected-job
assessment case passed active/terminal recipe labels and restored resume action,
then expected a full run ID where the history intentionally abbreviates it.
The history assertion was corrected to the actual retained caption and job-stage
outcome for the subsequent focused assessment proof. No production history or
console allowance changed.

The earlier `e2e-UFMrwe` attempt exposed an unrelated reduced-composition Profile
preview/templates dependency: entering that route produced genuine 503/404
console errors when Resumes was absent. The lifecycle proof now navigates through
the supported Discovery preferences route, retaining strict console assertions.
This does not claim the optional Profile route defect is repaired, nor a new
complete-suite or hosted qualification.

### Unlimited monetary accounting classification

`model-accounting.spec.ts` completes two real source-bound query-plan actions
through the worker and controlled external model with known tokens but no dollar
receipt. Unlimited mode accepts repeated work, retains accepted provenance,
shows no reconciliation task, and keeps aggregate dollars null. Restoring a
finite monetary cap refuses another action before external dispatch and preserves
the accepted plan. The opposing case supplies reported cost but no token counts:
monetary completeness remains intact, while enabling a token-lane limit refuses
further work. The actual worker-kill recovery journey independently asserts
`costStatus=unresolved`, a retained unresolved call and null monetary total.
No receipt, accepted artifact, monetary gate or token gate is bypassed.

The focused accounting run on 12 November passed actual worker-kill recovery
(33.2 seconds) and both accounting cases, with zero retries. Final UI barriers
wait for the actual Digest response and a settled Start search action; the two
accounting cases then passed in 1.8 and 0.705 seconds (19.467 seconds total).
The current inventory count is not a claim of a new complete 68-case run.

### Initial person fit after ordinary search

The complete application's existing `discovery.search` action now invokes
Preparation's fit-only search recipe under the same run identity. It freezes
only newly committed job IDs, runs enrichment, role analysis, Requirements and
Fit, and performs no wording preparation or resume generation. Source outcomes
and assessment outcomes remain independent. Even all-source failure after
committed jobs retains and assesses that exact cohort. The explicit selected-ID
`assess` recipe recovers already saved jobs without another acquisition; it
retains Fit's manual-refresh fence for previously accepted qualification.

The five actual application journeys in `search-assessment.spec.ts` passed
**5/5** in `e2e-gZGyMg` on 12 November 2026: 81.973 seconds for the runner phase
and 91.042 seconds total, including a 7.720-second web build. They cover foreign
evidence refusal without a fabricated score, explicit saved-job recovery and
accepted-score preservation, cancellation after an actual worker kill with
preparation sealed and monetary usage still unresolved, immutable failed-job
outcomes across worker replacement while a later frozen job finishes, and
assessment of jobs retained by failed acquisition. The Python source SHA-256
was `bd1abbb101d458d4ae8c3138f990c5cab4c481987edf03fc73bec56c17b6074e` and
the source-candidate digest was
`c55424668e6eaf89193a9223ac2604c1c19a23724cf7144d64e025465f316561`.
There were zero retries; dependency locks and the 151-file web bundle remained
unchanged. The runner was macOS arm64, Node 26.13.0, with 12 reported CPUs.

The combined UI run `e2e-3A36VR` passed its five relevant search cases: ordinary
Jobs search assessed three new jobs as 10/10, 1/10 and 10/10; the unrelated saved
job remained unassessed. During a held model call after acquisition completed,
the real UI showed **Assessing saved jobs**, **0 of 3 jobs assessed · 0 failed**,
disabled Start search and no dismiss action. It later showed 3 of 3 assessed,
the actual fit values and restored launch/dismiss controls. Screenshots were
inspected. The partial assessment case showed its fit-specific heading and
failed count; preference reads/saves retained zero model work, lost admission
was reconciled, cancellation remained exact and two tabs admitted one run.

That combined six-case invocation was not fully passing: the separate Companies
fixture removed Requirements, Fit and Resumes while its Job Detail assertions
still used their public reads, producing real 404 console errors. Its source-only
composition was corrected to retain those read owners while removing only
Preparation; no console allowance or production masking was added. The initial
saved-score refresh proof also exposed an incorrect harness expectation: the
actual `fit_refresh_required` refusal correctly prevented another qualification.
The test now verifies that fence and unchanged accepted score. Neither attempt
is recorded as passing. These focused results do not establish a new whole-suite,
hosted, installed-provider, release or deployment qualification.

The final explicit saved-job recovery/UI case passed **1/1** in `e2e-cJf22K`:
1.8 seconds for the case, 7.017 seconds for the runner phase and 17.021 seconds
total, including an 8.436-second build. While Fit was held, Job Detail showed
**Assess fit**, a disabled **Assessing fit…** action, the factual assessment
stage and no resume selector. On completion it restored **Resume to prepare**
and **Prepare resume**, with the recorded assessment in job/stage history.
The accepted score, manual-refresh refusal, absent new acquisition and absent
wording/resume work remained verified. A native held-state screenshot was
retained. The final 151-file web SHA-256 was
`6dd6eabdd722441908800c7ea19de80411441a10d99924597c4ae5b9a68d181c`;
Python source SHA-256 was
`58d1aa1340bfb2859a7ce2b534e78fe67ecebd809a954e2040f37831350b2163`.
Retries were zero, and web build and dependency locks remained unchanged.

The prior three-case `e2e-ebJ54I` invocation passed the SDK lifecycle and corrected
source-only Companies cases, including the explicit unavailable-assessment
notice, but failed the new recovery UI assertion because it expected a full run
ID that the history view does not render. The corrected assertion verifies the
actual recipe caption and exact job/stage/score row, while the public run read
retains durable identity. That attempt remains partial proof, separate from the
final passing recovery case. All Python code bytes remained identical to the
five-case recovery run; only Discovery's owning README changed the source-tree
hash. The listed inventory is now 73 journeys in 29 spec files, without a new
complete-suite claim.
