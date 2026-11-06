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

The complete installed application run `e2e-Htgt0Q` passed all **22 Chromium
journeys**, with zero failures, skips or flaky results and no test retries. It
used the extracted unsigned minimal application payload on macOS arm64 / 12 CPUs
/ Node 22.21.1, the component-lock CPython 3.12.12 runtime and Temporal CLI 1.7.3
(Server 1.31.2). The actual JobCtrl import came from the payload's
`worker/site-packages/jobctrl`; dependency-origin proof also placed HTTPX,
Pydantic, Temporal and Playwright inside that payload. No checkout import or
source-resource fallback participated.

The command recorded 67 ms import/origin preparation, 2,402 ms real application
composition preflight, **0 ms web build**, 202,126 ms journeys and **204,642 ms
total**. The Python lockfile and frozen web build were unchanged. The tested
worker wheel SHA-256 was
`33d3504d3e0dd50950627ae9d3d441d1e0925156e5e4b26902f6bd6cc2ff24be`,
with all 313 installed source files byte-identical to the frozen source. The
tested web SHA-256 was
`0b172f2c478f9d690e77aa43a3485b4e977abad3547d8460027a75ca84a1d282`.
Its real component-lock runtime archives were verified before extraction:
CPython `7e162bf77f6c2ecd7602960162c1b867eb61ac348863546e66db632b5731a5ea`
and Temporal `ed0357cd77aef432021556c36c3b68bfbe38b86677dd7db86575abd312dc56c7`.

The installed command is `node scripts/run-e2e.mjs --installed --project=chromium`
with `JOBCTRL_E2E_PAYLOAD_DIR`, `JOBCTRL_E2E_PYTHON`, `JOBCTRL_E2E_STATIC_DIR`,
`JOBCTRL_TEMPORAL_CLI_PATH` and `PLAYWRIGHT_BROWSERS_PATH` selecting that extracted
payload. The runner validates canonical interpreter/static/import containment
and supplies the real bundled runtime environment. The status column below
refers to this complete installed run unless it explicitly names the demo.

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
| Hosted demo | Real demo bundle, consent Worker and D1; owned browser state, local edits/export and no Python API traffic | Isolated actual browser journey passed; runtime errors empty and no `/v1` traffic |

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
The complete installed run above subsequently exercised the pinned CLI 1.7.3
runtime. Hosted execution remains a separate gate.

Focused follow-up `e2e-cOQbyj` ran four journeys: optional-module Jobs refusals,
Learning recovery and Preparation recovery passed; the global Jobs journey still
failed. Its complete command took 39,849 ms (8,515 ms build, 29,921 ms journeys).
The final global Jobs follow-up `e2e-kz95to` passed in 19,475 ms total (8,539 ms
build, 9,646 ms journeys) with web SHA-256
`0b172f2c478f9d690e77aa43a3485b4e977abad3547d8460027a75ca84a1d282`.
Both used the same frozen Python/policy hash above, and their locks/static builds
were unchanged. Every one of the 22 Chromium journeys has therefore been
observed passing across the full and focused evidence. This is not a single
passing 22-journey source run. The complete installed result above supplies the
single passing 22-journey application run; hosted source CI remains separate.

The isolated demo run `e2e-tNQ809` passed one journey with the real consent Worker,
D1 and compiled demo bundle. Its isolated demo build took 8,101 ms, demo setup
10,196 ms and complete command 23,691 ms. The generated PDF was downloaded,
read back as text and inspected as page images. This is demo qualification and
does not replace the Python/worker journeys or a hosted deployment proof.

The installed result qualifies these recurring application journeys against the
tested minimal payload. That payload was unsigned and did not install provider
packs; its assembly metadata explicitly records
`fullDistributionClosureQualified: false`. It does not qualify signed/notarized
acquisition, the complete release distribution, published-predecessor lifecycle,
hosted platform permissions or live model authentication, quality and pricing.
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
entrypoint/platform proofs before release. A controlled HTTP boundary cannot
prove those outcomes. Record the exact commands, candidate, runner, timings and
unverified gaps without inferring readiness from test deletion or a green build.
