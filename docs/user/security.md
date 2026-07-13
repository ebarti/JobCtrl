---
pageClass: jh-user-guide-page
next: false
---

# Security

JobCtrl is local-first software with one high-risk capability: it can drive a
browser or Gmail connector to submit a real application. Security therefore
depends on both local data protection and binding controls around outbound
actions.

This page owns the user-facing enforcement model. The complete local-file
inventory is in [Data, Privacy & Safety](data-and-safety.md); exact controls are
in [Configuration](configuration.md); the repo threat model is in
[Developer Security](../developer/security.md#repository-threat-model).

## Privacy Quick Answer

- Your database, generated artifacts, browser state, and logs stay under your
  local control.
- Nothing calls a provider until you configure and use the related feature or
  explicitly enable its schedule.
- Local files are not encrypted by JobCtrl; OS account and disk protection are
  the at-rest boundary.
- Live apply is approval-gated by default, dry-run is blocked at the browser
  network layer, and ambiguous post-submit recovery parks for verification.

## Public Demo Boundary

The public synthetic demo never connects to the local JobCtrl API, worker,
browser extension, model providers, job boards, Gmail, or application
submission transports. Its product state stays in the visitor's browser. A
same-origin Cloudflare Worker handles only consent, aggregate initialization
health, allowlisted analytics, and retention.

The demo is unavailable until the visitor accepts first-party analytics
cookies. A decline creates no visitor or session identifier and redirects to
`https://jobctrl.dev`; returning shows the consent screen again. Before a
confirmed grant, the app creates no demo IndexedDB workspace and sends no
health or product-telemetry event. Post-accept analytics failures never block
browser-local product interaction.

Telemetry schemas reject free-form content and product identifiers at both the
browser and Worker boundaries. Cloudflare automatic invocation logs and traces
are disabled for the demo Workers; only closed lifecycle outcomes may be
logged. Post-accept withdrawal and immediate visitor-event deletion are
deferred from this MVP, so the notice relies on the documented cookie and
90-day raw-data expiry instead of claiming an unavailable control.

## What Leaves Your Machine

| Outbound call | When | What can be sent |
| --- | --- | --- |
| LLM providers | Scoring, analysis, tailoring, cover letters, contact extraction | Posting text, relevant profile evidence, generated text, or opted-in page text. Employer analysis uses Claude, Codex, and Gemini legs. |
| Apply model | Apply/dry-run or an enabled standing loop | Profile application fields plus tailored resume/cover-letter text. Passwords and solver keys are excluded from the prompt. |
| Job/ATS/public pages | Discovery, enrichment, supervised contact research | Search terms and network/page requests. |
| Gmail | Authenticated verification/outcome flows or approved email applications | Bounded queries/evidence, or the exact reviewed send. |
| Google Maps | Configured profile autocomplete | Address text typed in the field. |
| CAPTCHA provider | Supported widget during an apply run you explicitly start or a standing loop you enable, with a configured solver | Site key and page URL through the local solver tool. |
| Langfuse/OpenTelemetry | Explicit telemetry configuration | Metadata-only provider/model, operation/stage, outcome, token-count, and safe-size span attributes. |

The apply prompt is the largest single transfer of personal data. Review a
dry-run and keep targets narrow before live submission.

## What Stays On Your Machine

The local authorities are `jobctrl.db` (profile, jobs, discovery, events and
projections), bundled `temporal.db`, `dashboard.json` (non-secret runtime
settings), `.env` and `gmail/` (credentials), `codex_home/` and provider-runtime
directories, generated material/log directories, browser capability/profile/
worker state, `backups/`, and legacy resume inputs. Their text may still be sent
when an explicitly used model or external integration needs that content;
configured telemetry remains metadata-only.

Browser authority is stored specifically in `browser-capabilities.json`,
`browser-profiles/`, and `extension-capability-token`.

::: warning Local does not mean encrypted
JobCtrl does not encrypt `jobctrl.db`, `.env`, or generated artifacts. Protect
your OS account/disk and never attach `~/.jobctrl/` to a bug report.
:::

## Browser Extension Pairing

The extension uses a local capability token for `/v1/extension/*` loopback
routes. Settings can display/rotate it only from the CLI or same-origin Settings
surface. The token does not make a remote API bind safe.

Capture requires a click and sends the active page URL/visible text to the local
API. If the stack is down, the extension holds a bounded local queue. Autofill
reads only whitelisted profile fields on supported ATS hosts, shows a review
panel, and never calls submit. Passwords, resume content, and generated free-text
answers are excluded.

## Approval And Control Gates

### Apply Approval Is Required By Default

With `applyApprovalRequired: true`, the latest decision must be
`approve_submit` and bind the current materials generation, profile version,
application URL, and qualifying dry-run evidence. A partial rehearsal requires
an explicit approval for that run and its blocked channels.

The Python launcher's atomic claim checks the binding. This is not a UI-only
warning, so API/RPC dispatch cannot bypass it while enabled. Turning the setting
off permits a claimed live run to submit without per-job approval; the UI keeps
a persistent warning visible.

Email-only applications use the same binding for the exact recipient and resume
attachment. Missing scope, sender, or fresh approval fails closed.

### Dry-Run Cannot Submit

Dry-run combines instruction with enforcement. A Chrome DevTools Protocol guard
blocks mutating requests, form submission, WebSocket/beacon channels, scripted
navigation, and data-bearing subresource exfiltration. Ordinary page navigation
remains available for rehearsal.

Because the browser enforces the boundary, safety does not depend on the agent
choosing not to click Submit.

### Authenticated Browser Capabilities Are Explicit

The source checkout uses its managed Playwright Chromium installs for core
discovery, enrichment, and PDF rendering. The bundled payload uses exactly one
managed Playwright Chromium headless shell and includes no full Chrome/Chromium
application. Auto-apply and authenticated LinkedIn resolution are disabled
separately. JobCtrl will not launch, read, or copy an authenticated system
browser profile until the relevant capability has an explicitly adopted
Chrome/Chromium executable. LinkedIn additionally requires a separate
affirmative profile-copy consent; `--yes` is not consent. The copied profile
lives only in JobCtrl-owned storage, and JobCtrl records consent metadata but
never the source-profile path.

### Applications Submit At Most Once

An apply run cannot claim a job already running, succeeded, or awaiting
verification. Immediately before a live submit it records a durable submit
intent. If the process then dies without a terminal result, recovery parks the
job in `needs_verification` instead of retrying.

### Daily LLM Spend Ceiling

`dailyBudgetUsd` defaults to `25`; `0` means unlimited. Spendful workflows run a
preflight and stop non-retryably after the daily estimate reaches the limit. It
is a coarse workflow-start guard, not provider billing truth or a mid-call kill
switch.

### No Third-Party Bypass

JobCtrl does not bypass login, paywall, rate-limit, bot-control, identity,
biometric, payment, or bank-detail gates. The apply agent declines browser
permission prompts and stops on SSO/OAuth or unsupported CAPTCHA. Supported
CAPTCHA solving uses only the owned local tool; provider keys/tokens never enter
the model prompt. Setting `CAPSOLVER_API_KEY` is explicit authority to send the
supported widget's site key and page URL during apply work you start or a
standing loop you enable. Without that authority, or for unsupported/failed
challenges, the apply path stops.

### Crawl Politeness

Discovery/enrichment uses one gateway for controlled HTTP and Playwright fetches:

- `robots.txt` is enforced for page rendering: `2xx` parses the file, `4xx`
  means absent, `5xx`/timeout is inconclusive and fails closed, and definitive
  network absence fails open with a warning;
- targets, redirects, and subrequests must be public HTTP(S)—loopback, private,
  link-local, metadata, and file URLs are blocked;
- per-host pacing, concurrency, and per-run request budgets limit load;
- one honest JobCtrl user agent is used instead of browser impersonation; and
- denied/rate-limited/budget/unsafe destinations are recorded as outcomes, not
  generic scrape errors.

`python-jobspy` owns its internal board transport, so JobCtrl can apply only
invocation-level pacing/budget there. Authenticated LinkedIn uses the user's real
browser session but remains rate/budget limited. See
[Configuration → Crawl Politeness](configuration.md#crawl-politeness).

## Credentials

Codex-backed work requires an authenticated Codex CLI before JobCtrl can reuse
or verify that login.

| Secret | Boundary |
| --- | --- |
| Provider/runtime keys | Shell, plaintext `~/.jobctrl/.env`, or the guided macOS Keychain boundary; never SQLite. |
| Codex login | Stable `$JOBCTRL_DIR/codex_home/auth.json`, separate from SQLite and the normal Codex home. Valid normal CLI auth may be reused once only when this file is absent; existing isolated auth is never overwritten, and prompt-driven reads are limited to `codex_home/workspace/`. |
| Claude/Google web entries | Keychain for API keys plus cloud activation flags/non-secret identifiers; AWS, Google, and Azure credential files remain in their vendor stores. Status only is returned. |
| CAPTCHA key | `CAPSOLVER_API_KEY` saved from Settings to Keychain on macOS, or supplied by the environment elsewhere; read by the owned local solver, not the model. |
| Job-site passwords | Optional local profile value typed through a focused-field credential tool, never returned to the model. |

Environment values win over Keychain and make the matching Settings control
read-only. Keychain is loaded only for missing/empty values at process startup,
so restart the relevant Python process after Claude, Google, or CapSolver
changes. Codex verification, model preference, browser capability, and
extension-pairing changes do not require that restart. Provider
replacement is atomic from the web contract; stored secrets are used internally
only to restore a failed batch and never cross the HTTP boundary. Windows and
Linux use environment configuration today.

## The Apply Agent

The local Claude runtime drives Chrome through an explicit apply-tool allowlist.
It has browser form tools and bounded verification-code access—not shell/file
access, raw mailbox/send tools, broad permission bypass, or arbitrary page
script evaluation. Owned JobCtrl code performs approved email application sends.

::: warning Prompt injection remains a real risk
The agent reads untrusted pages that can attempt to manipulate it. The controls
limit consequences; they cannot make untrusted page content safe.
:::

The practical containment layers are browser-enforced dry-run, bound approval,
at-most-once submission, spend limits, local credential tools, and hard prompt
rules against fabricated answers, permissions, or sensitive payments. If a
legal/screening attestation is missing, the agent stops instead of guessing.

## Scoring Is Applicant-Side Only

Fit scores help the applicant prioritize. They are not employer-side screening
and must not rank people for hiring without separate legal, bias-audit,
validation, notice, and human-review controls.

## Reporting A Security Issue

Prefer GitHub private vulnerability reporting. Otherwise request a private
contact path in a minimal public issue; omit exploit details, secrets, logs,
profiles, artifacts, and local paths. See [SECURITY.md](../../SECURITY.md).
