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

### Original redesign inventory — 11 November 2026

The current source inventory has **57 journeys in 25 spec files**: 56 Python
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
Preparation, source equality and import-origin receipts are recorded under
`/private/tmp/jobctrl-transform-1428/installed-application-_ajwp183/`.
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
