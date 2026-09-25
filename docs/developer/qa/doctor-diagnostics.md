---
description: "Inventory what jobctrl doctor checks, what its statuses mean, and which integration behavior still needs separate verification."
---

# Doctor Diagnostic Coverage

`jobctrl doctor` is a local setup report. It reads local configuration and
selected state, checks installed capabilities, and makes two bounded connection
probes. It exits zero even when it prints `MISSING`; callers must inspect the
rows. The final tier is a separate feature gate, not a count of successful
rows. This assessment describes the current CLI implementation and the
controlled [Typer CLI cases](../../../workers/automation/tests/test_doctor_diagnostics.py).

**Read this if** you are changing a doctor check or using its output to decide
which integration needs further verification. For user setup, use
[Getting Started](../../user/getting-started.md); for check selection, use
[Reliability & QA](../../local-reliability-qa.md).

## What the command observes

| Surface | Local check and possible report | Boundary the report does not cross |
| --- | --- | --- |
| Provider credential source | `load_env()` reports inherited environment precedence, native-store values loaded for this process, unavailable/unsupported native storage, or no entries. macOS uses Keychain, Windows Credential Manager, and Linux Secret Service; an unsupported platform is environment-only. | A loaded value is not a successful provider request. A worker must restart after a Settings credential change. No secret value is printed. |
| Candidate profile and screening attestations | Loads the local tenant profile from SQLite. No profile or validation failure is `MISSING`; four typed application attestations are `OK` when present, otherwise `WARN`. | A valid local profile or complete attestations do not prove an employer form will accept them. |
| Resume | Checks the configured plain-text path, then PDF path. Text is `OK`, PDF-only is `WARN`, and neither is `MISSING`. | No parsing, rendering, tailoring, or factual validation runs. |
| Core browser | The browser-capability preflight checks the managed Playwright Chromium used for scraping and PDF rendering. Ready is `OK`; otherwise `MISSING`. | No browser is launched and no page or PDF is exercised. |
| Optional auto-apply and authenticated LinkedIn browsers | Reads explicit capability state and adopted executable; LinkedIn also requires a consented JobCtrl-owned profile copy. Reports `OK`, `DISABLED`, `WARN` for missing, or `MISSING` for failed/unavailable. Disabled is the default and does not probe a system Chrome installation. | No browser session, account authentication, site access, profile copy, or form fill is exercised. |
| Discovery settings and JobStreaming | Loads SQLite-backed search settings (`OK` or `WARN`) and imports the pinned JobStreaming package/version (`OK` or `MISSING`). | No board connection, source policy response, crawl, checkpoint replay, or worker execution is tested. |
| Core analysis providers | Shared setup probes check enabled legs, Claude/Codex/Google SDK presence and local auth routes; any one ready SDK/auth pair satisfies the core LLM provider row. Individual provider failures are optional rows. | Local SDK/auth detection is not an inference call, provider health check, model availability check, or proof all enabled analysis legs can run. |
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

## Controlled CLI evidence and remaining verification

`test_doctor_diagnostics.py` invokes the real Typer `doctor` command with an
owned temporary directory and synthetic credential, profile, browser, provider,
Temporal, and HTTP boundaries. It observes missing profile/browser/Temporal and
disabled optional browsers, a disabled Langfuse export without HTTP, synthetic
healthy local dependencies, source `npx` versus a bundled executable wrapper,
and a Langfuse status matrix. In the pre-fix command, synthetic HEAD 404 produced
`Langfuse OK reachable`; the same case now reports `MISSING` with status 404.
All these cases retain diagnostic exit code zero.

These controlled statuses verify classification and command wiring. They do not
verify a live Keychain, Credential Manager, Secret Service, user database,
provider, board, browser, Gmail account, Temporal worker, CapSolver account, or
Langfuse ingestion. They also do not establish API/web health, extension
connection, end-to-end workflow recovery, or application submission. Those
claims require their owning product-path checks under
[Reliability & QA](../../local-reliability-qa.md), using an owned synthetic
workspace and the applicable external service only when separately authorized.
