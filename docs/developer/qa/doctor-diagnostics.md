---
description: "Inventory what jobctrl doctor checks, what its statuses mean, and which integration behavior still needs separate verification."
---

# Doctor Diagnostic Coverage

`jobctrl doctor` is a local setup report. It reads local configuration and
selected state, launches and closes managed Chromium, checks installed
capabilities, and makes bounded Temporal and Langfuse probes. It exits zero
even when it prints `MISSING`; callers must inspect the
rows. The final tier is a separate feature gate, not a count of successful
rows. This assessment describes the current CLI implementation and the
controlled [Typer CLI cases](../../../workers/automation/tests/test_doctor_diagnostics.py).

**Read this if** you are changing a doctor check or using its output to decide
which integration needs further verification. For user setup, use
[Getting Started](../../user/getting-started.md); for check selection, use
[Reliability & QA](../../local-reliability-qa.md).

Existing coverage includes the [diagnostic inventory, Langfuse response
classification and controlled Typer cases](https://github.com/ebarti/JobCtrl/pull/979),
and [source-mode Node.js 22.13+ guidance and bundled-wrapper
checks](https://github.com/ebarti/JobCtrl/pull/977). The remaining gaps below concern
integration proof beyond those local checks.

## Test isolation

Doctor tests use synthetic inputs for unrelated host boundaries. Temporal cases
exercise the client factory with a mocked connection; Langfuse cases own their
HTTP and disable state; Gmail cases own their diagnostic inputs; budget cases
use actual accounting in a disposable SQLite database. These fixtures must not
read host credentials or start unrelated processes.

## What the command observes

| Surface | Local check and possible report | Boundary the report does not cross |
| --- | --- | --- |
| Provider credential source | `load_env()` reports inherited environment precedence, native-store values loaded for this process, unavailable/unsupported native storage, or no entries. macOS uses Keychain, Windows Credential Manager, and Linux Secret Service; an unsupported platform is environment-only. | A loaded value is not a successful provider request. A worker must restart after a Settings credential change. No secret value is printed. |
| Candidate profile and screening attestations | Loads the local tenant profile from SQLite. No profile or validation failure is `MISSING`; four typed application attestations are `OK` when present, otherwise `WARN`. | A valid local profile or complete attestations do not prove an employer form will accept them. |
| Resume | Checks the configured plain-text path, then PDF path. Text is `OK`, PDF-only is `WARN`, and neither is `MISSING`. | No parsing, rendering, tailoring, or factual validation runs. |
| Core browser | The browser-capability preflight launches and closes the managed Playwright Chromium headless shell used for scraping and PDF rendering. Success is `OK`; otherwise `MISSING`. | No page is visited and no PDF is rendered. |
| Optional auto-apply and authenticated LinkedIn browsers | Reads explicit capability state and adopted executable; LinkedIn also requires a consented JobCtrl-owned profile copy. Reports `OK`, `DISABLED`, `WARN` for missing, or `MISSING` for failed/unavailable. Disabled is the default and does not probe a system Chrome installation. | No browser session, account authentication, site access, profile copy, or form fill is exercised. |
| Discovery settings and JobStreaming | Loads SQLite-backed search settings (`OK` or `WARN`) and imports the pinned JobStreaming package/version (`OK` or `MISSING`). | No board connection, source policy response, crawl, checkpoint replay, or worker execution is tested. |
| Core analysis providers | Shared setup probes check enabled legs, Claude/Codex/Google SDK presence and local auth routes; Codex auth can run a bounded `login status` subprocess. Any one ready SDK/auth pair satisfies the core LLM provider row. Individual provider failures are optional rows. | Local SDK/auth detection is not an inference call, provider health check, model availability check, or proof all enabled analysis legs can run. |
| Claude apply runtime and budget flag | Resolves the configured executable, checks local existence/PATH, and checks whether it advertises `--max-budget-usd`; missing runtime is `MISSING`, absent flag is `WARN`. | No apply agent is run and no budget enforcement is exercised. In bundled mode the apply runtime is invoked bare under the payload/provider policy. |
| Playwright MCP / Node | Bundled mode checks the payload-owned executable Playwright MCP wrapper. Source mode checks only that `npx` is on PATH. A missing component is `MISSING`. | The bundled wrapper does not depend on system `npx`; neither check starts MCP, verifies Node version, or drives a page. |
| Gmail connector | Inspects local OAuth client/token JSON and the `gmail.send` scope; missing/invalid state is `WARN`. | No token refresh, Gmail API request, verification lookup, or email send occurs. |
| CapSolver | A configured key is reported as `configured`; absent is `optional`. | No key validation, balance query, CAPTCHA solve, or external request occurs. |
| Apply approval gate | Reads the effective local approval-required setting. Enabled is `OK`; explicitly disabled is `WARN`. | It does not start a run or prove approval binding at a live submit boundary. |
| Temporal | Attempts to obtain a Temporal client with a three-second bound. Connection is `OK reachable`; failure is `MISSING unreachable`. | A connection does not prove the JobCtrl worker is polling, workflows execute, or the configured namespace matches retained history. |
| Langfuse | Disabled export is `disabled`; missing public key, secret key, or base URL is `MISSING`. Otherwise an unauthenticated HEAD to the configured OTLP trace path is `OK reachable` for 2xx, 401, or 405; redirects, other 4xx, 5xx, and transport failures are `MISSING unreachable`. | HEAD does not send the configured Basic credentials or a span. `reachable` does not prove authentication, ingestion, export delivery, or trace visibility. A 404 trace route is not reported reachable. |
| Crawl posture | Shows the configured user agent, whether broad boards are active, and locally recorded robots/rate-limit blocks. Problems in this disclosure do not stop doctor. | This is local posture/history, not a robots decision or live source probe. |
| LLM spend | Reads local global estimated USD and each lane's recorded token total versus configured thresholds; exceeded limits are `WARN`. Accounting read failure is `WARN`. | Prior observations are not a reservation for an in-flight call and do not validate a provider invoice. |
| Tier summary | `get_tier()` separately checks whether a core LLM provider is ready and whether Claude apply plus an enabled auto-apply browser are present. | It is not a whole-system readiness verdict; `MISSING` rows can coexist with any tier. |

## Residual integration proof

These are missing proofs and their owning layers, not newly implemented checks.
The table above remains the command's status contract.

| Residual | Current source and existing evidence | Missing proof / safe validation method |
| --- | --- | --- |
| OS credential support | [Native credentials](../../../workers/automation/src/jobctrl/native_credentials.py) owns Darwin/Windows/Linux selection, unsupported-platform handling and bounded store operations; `config.load_env()` owns environment precedence. [Adapter tests](../../../workers/automation/tests/test_native_credentials.py) and the doctor credential-source row distinguish local detection from auth. | Synthetic CLI inputs do not prove a real OS store is available, unlocked or accessible. First test supported/unsupported/unavailable adapters with synthetic runners; a real per-OS store check requires separate consent and disposable entries, including cleanup. Never infer provider authentication from presence or change Settings' credential ownership. |
| Source versus bundled dependencies | [Runtime policy](../../../workers/automation/src/jobctrl/runtime.py), [setup probes](../../../workers/automation/src/jobctrl/infrastructure/setup_probes.py) and `doctor()` own runtime selection. [Playwright CLI tests](../../../workers/automation/tests/test_doctor_playwright.py) cover missing source `npx`, bundled executable presence and rejection of non-executable wrappers. | PATH presence does not verify Node version; a wrapper file does not prove MCP starts or negotiates. Validate a separately built payload and a source checkout using synthetic local inputs and the existing distribution smoke path. Do not replace the payload wrapper with host `npx` or treat source results as installed-product evidence. |
| Browser / PDF readiness | [Browser capabilities](../../../workers/automation/src/jobctrl/browser_capabilities.py) delegates core readiness to [launch/close preflight](../../../workers/automation/src/jobctrl/infrastructure/preflight.py). Disabled optional capabilities stay disabled. [PDF ports](../../../workers/automation/tests/test_pdf_renderer_ports.py) own rendering proof. | A launched browser proves neither navigation nor PDF output/layout; mocked preflight proves classification only. Use managed Chromium with an in-memory synthetic page and synthetic resume/letter through the owning renderers, inspect output, and clean up. No user browser/profile adoption, authentication or real site access is implied. |
| Temporal connection versus worker execution | [Client factory](../../../workers/automation/src/jobctrl/infrastructure/temporal/client.py) owns address/namespace; `doctor()` waits up to three seconds for a client. [Temporal CLI cases](../../../workers/automation/tests/test_doctor_temporal.py) retain that factory and synthetic reachable/unreachable outcomes. | Connection says nothing about polling, task queue, workflow completion, restart or history compatibility. Use a disposable local namespace/queue and existing synthetic workflow tests; retain exact workflow/run IDs through restart and cleanup. The [pipeline owner](../../architecture/pipeline/index.md) owns execution/recovery, not doctor. No live worker or recovery result is established here. |
| Board dependencies | `doctor()` imports JobStreaming and reads settings; the [gateway](../../../workers/automation/src/jobctrl/infrastructure/discovery/jobstreaming_gateway.py) and [gateway tests](../../../workers/automation/tests/test_jobstreaming_gateway.py) own adapter behavior. `config.resolve_jobspy_boards()` retains `boards` with the legacy `sites` alias and canonical `jobspy:` source IDs. | An import/version row proves no board availability, transport, pacing, result correctness or checkpoint recovery. Exercise adapter calls/events with owned synthetic responses first. Any later public-board smoke needs explicit destination/request scope and separate authorization; never rename stored IDs, manufacture a source identity, or use real search/profile data for this inventory. |
| Bounded smoke diagnostics | `doctor()` has a three-second Temporal wait and two-second Langfuse HEAD request; setup's Codex login-status call has a ten-second subprocess timeout and binary-version calls use five seconds. [Langfuse CLI cases](../../../workers/automation/tests/test_doctor_langfuse.py) and the status matrix below cover disabled/missing/transport outcomes. | There is no integrated smoke mode or overall doctor deadline. Browser preflight passes no explicit launch timeout. HEAD does not authenticate or ingest; local Gmail/CapSolver/provider checks do not execute those services. A future smoke must bound each permitted operation, prove cancellation/cleanup and label each result's limits. |

### Future smoke validation design (not implemented)

Keep smoke separate from default doctor. Before execution, obtain explicit
scope for destinations, accounts, credentials, operations and any spend; show
which operations are local reads, process launches or network requests.
Start with owned synthetic fixtures and a disposable workspace/config/database.
An absent permission, unavailable dependency or unknown identity remains an
explicit unverified result; a successful local row cannot authorize a request.

The smallest local browser smoke would render fixed synthetic HTML with network
blocked, inspect the PDF through the existing renderer checks, then close every
page/browser and remove its generated files in `finally`. Optional capabilities
must remain off unless explicitly enabled; never copy an existing host profile.
The smallest Temporal execution smoke would use the existing test environment
and synthetic workflow, record namespace/queue/workflow/run identity, prove
terminal completion and a separately scoped restart/resume case, then terminate
only owned work and stop only its own server. Neither design is a new CLI mode.

Preserve the existing two-/three-/five-/ten-second probe bounds above when testing
their owners. Any additional operation needs an explicit operation bound and
cleanup assertion in its future owning check; current doctor has no aggregate
deadline. Negative tests should prove missing dependencies, timeout, cancellation
and disabled behavior without reaching a host service. Do not perform external
provider calls, account login/refresh, board discovery, ingestion, message sends,
CAPTCHA solves or submission to obtain a green setup report. Provider auth/model
availability, live boards, Gmail accounts and Langfuse trace ingestion remain
unverified without separate authorized product-path evidence.

## Verification boundaries

`test_doctor_diagnostics.py` invokes the real Typer `doctor` command with an
owned temporary directory and synthetic credential, profile, browser, provider,
Temporal, and HTTP boundaries. It observes missing profile/browser/Temporal and
disabled optional browsers, a disabled Langfuse export without HTTP, synthetic
healthy local dependencies, source `npx` versus a bundled executable wrapper,
and a Langfuse status matrix. Synthetic HEAD 404 reports `Langfuse MISSING`
with status 404.
All these cases retain diagnostic exit code zero.

These controlled statuses verify classification and command wiring. They do not
verify a live Keychain, Credential Manager, Secret Service, user database,
provider, board, browser, Gmail account, Temporal worker, CapSolver account, or
Langfuse ingestion. They also do not establish API/web health, extension
connection, end-to-end workflow recovery, or application submission. Those
claims require their owning product-path checks under
[Reliability & QA](../../local-reliability-qa.md), using an owned synthetic
workspace and the applicable external service only when separately authorized.
