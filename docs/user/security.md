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

## What Leaves Your Machine

| Outbound call | When | What can be sent |
| --- | --- | --- |
| LLM providers | Scoring, analysis, tailoring, cover letters, contact extraction | Posting text, relevant profile evidence, generated text, or opted-in page text. Employer analysis uses Claude, Codex, and Gemini legs. |
| Apply model | Apply/dry-run or an enabled standing loop | Profile application fields plus tailored resume/cover-letter text. Passwords and solver keys are excluded from the prompt. |
| Job/ATS/public pages | Discovery, enrichment, supervised contact research | Search terms and network/page requests. |
| Gmail | Authenticated verification/outcome flows or approved email applications | Bounded queries/evidence, or the exact reviewed send. |
| Google Maps | Configured profile autocomplete | Address text typed in the field. |
| CAPTCHA provider | Configured supported widget | Site key and page URL through the local solver tool. |
| Langfuse/OpenTelemetry | Explicit telemetry configuration | Prompts/completions and workflow/JSON-RPC spans. |

The apply prompt is the largest single transfer of personal data. Review a
dry-run and keep targets narrow before live submission.

## What Stays On Your Machine

The SQLite database, generated files, browser/apply state, raw Gmail bodies,
logs, and local traces stay on disk. Their *text* may still be sent when a model
generates or applies with that content, or when configured telemetry exports it.

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
the model prompt.

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

| Secret | Boundary |
| --- | --- |
| Provider/runtime keys | Shell or plaintext `~/.jobctrl/.env`; never SQLite. |
| macOS web credential entries | Keychain for `OPENAI_API_KEY`, `GEMINI_API_KEY`, and `LLM_URL`; status only is returned. |
| CAPTCHA key | `CAPSOLVER_API_KEY` read by the owned local solver, not the model. |
| Job-site passwords | Optional local profile value typed through a focused-field credential tool, never returned to the model. |

Environment values win over Keychain. Keychain is loaded only for missing/empty
values at process startup, so restart after changes. Windows and Linux use
environment configuration today.

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
