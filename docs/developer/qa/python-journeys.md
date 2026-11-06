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
application exceptions and HTTP status classes remain failures.
One Temporal server serves bounded, independent per-journey Python workspaces.
Processes and state are owned by the run; caller-selected application paths and
real credentials are never adopted. The IPC-connected process-group leader
reserves its group identity until cleanup and cleans its group if the harness
disconnects. Test evidence lives in an owned temporary run directory. Failed
synthetic state stays local for diagnosis; CI uploads selected logs, timings,
traces and reports and excludes databases, native HOME and provider state.

## Coverage ledger

| Journey | Critical behavior replacing legacy evidence | Status |
| --- | --- | --- |
| Python boundary and committed updates | Real health/configuration, loopback auth/origin refusal, browser load and one event connection; committed mutation reaches the browser; valid-body HEAD cannot mutate canonical records/events | Passed frozen full run |
| Baseline editing and recorded PDF | Every role/achievement, actual Plate edit, exact edit approval, separate draft/accepted revisions, actual PDF text and page images, historical PDF.js preview and browser-download SHA; zero model calls | Render/export passed; real browser edit exposed contradictory Plate/semantic payload; owning frontend fix awaits run |
| Approved tailored resume | Requirements vs factual Fit vs wording coverage; pending proposal and exact Profile approval; complete deterministic composition, advisory review/override, failed review/render retain accepted bytes | Accepted PDF path passed; later saved-resume selector repair awaits run |
| Meaning authority and failed refresh | Opposing explicit model decisions, paraphrase reuse/qualified distinction, unsupported/invalid output, source mutation during inference and preserved accepted snapshot | Passed frozen full run |
| Profile identity and conflicting saves | Concurrent same-revision saves admit one writer; stale exact approval refuses; actual form preserves stable achievement IDs, nested extras and literal policy values | Full form round-trip and conflict assertions passed frozen full run |
| Durable cancellation and restart | Hold external request, cancel via HTTP, SIGKILL actual worker, start distinct worker, inspect original run and accepted-artifact preservation; honest unknown-spend refusal followed by explicit unlimited-money policy | Cancellation settled in 31.1 s; follow-up correctly refused unresolved spend; repaired policy assertions await run |
| Application intent and uncertainty | Current factual Fit, exact prepared/rehearsed/approved payload, changed input invalidates approval, real mail POST after persisted intent, worker death, uncertain status and no second send after restart | Passed frozen full run |
| Optional capabilities | Reduced composition; contact/research/Outreach review and manual-send receipt retry; Interviews/Learning/Digest recovery; Compensation/Offers evidence, unknowns and history | Seven passed; Learning test waited for headers before abort and blocked itself; repaired test awaits run |
| Extension and setup | Real pairing/rotation/capture receipt and broker lease; public setup CLI and external credential command | Setup and two Extension journeys passed; doctor exposed missing frozen source policy, topology/resource repair awaits run |
| Composed Jobs query | Global pagination/filter/facets, saved selection/navigation and optional-module refusal | Preparation action and filter-selector failures under owner investigation; not qualified |
| Preparation admission recovery | Genuine lost acknowledgement, changed input/navigation/reload, reconcile original durable run before any new admission | One compact journey authored and discovered; not yet run |
| Hosted demo | Real demo bundle, consent Worker and D1; owned browser state, local edits/export and no Python API traffic | First isolated run found duplicate heading selector; owner repair and actual rerun in progress |

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

Record the next complete result, hashes and setup/total timings before claiming
this ledger is verified. Authored assertions and separate owner probes do not
substitute for executing the recurring journeys.

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
