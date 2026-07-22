<script setup lang="ts">
import SecurityLayers from "../.vitepress/theme/SecurityLayers.vue";
</script>

# Security & Hardening

JobCtrl is local-first software with one high-risk capability: it can drive a
browser or Gmail connector to submit a real application. Security therefore
depends on both local data protection and binding controls around outbound
actions.

This page owns the user-facing enforcement model. The complete local-file
inventory is in [Data, Privacy & Safety](data-and-safety.md); employer-facing
setup is in [Apply](apply.md), discovery access policy is in
[Discovery](discovery.md), and shared provider/spend controls are in
[Configuration](configuration.md). The repo threat model is in
[Threat Model & Security Engineering](../developer/security.md#repository-threat-model).

## Implemented Hardening

JobCtrl uses defense in depth: the model prompt, UI, API, worker, browser, local
tools, persistence layer, and release path each enforce a narrower part of the
security contract. No single prompt or checkbox is treated as the security
boundary.

<SecurityLayers />

| Boundary | Enforced protection |
| --- | --- |
| Local API | Loopback bind, loopback `Host` and peer-address checks, first-party mutation origins, Fetch Metadata validation, and a worker-readiness gate. |
| Browser extension | Rotatable local capability token, same-origin-only token management, a whitelisted autofill DTO, and no submit capability. |
| Outbound browsing | Public HTTP(S)-only destination validation across initial URLs, redirects, final pages, popups, and guarded subrequests. Private, loopback, link-local, metadata, and file destinations are blocked. |
| Credentials and files | Secrets stay outside SQLite and `config.json`; status APIs are secret-free; saved passwords and reviewed artifacts can be used only by origin-bound local tools. |
| Provider runtimes | JobCtrl-owned provider state, filtered subprocess environments, restricted tool surfaces, and prompt-driven filesystem boundaries isolate model execution from unrelated local data. |
| Application submission | Confirmed-history repeat protection, evidence-bound one-attempt confirmation, bound human approval, browser-enforced dry-run, durable submit intent, at-most-once claiming, and `needs_verification` recovery after an ambiguous crash. |
| Generated content | Structured outputs, literal evidence grounding, fabrication checks, provenance, judge review, and preservation of the last accepted artifact. |
| Bundled runtime | Payload path confinement, isolated Python startup, manifest verification, and hash-locked provider packs with activation-time revalidation. |
| Privacy and release | Metadata-only telemetry, synthetic-demo isolation, private local file modes for sensitive control files, and release scanning for secrets and private artifacts. |

## Public Demo Boundary

The hosted public demo uses synthetic data in a browser-local workspace. Its
shortcuts and actions are simulations: they do not contact employers, send
messages, or make external changes.

For the demo's analytics-cookie consent, Google Analytics scope, retention,
data-controller identity, and privacy contact, read the canonical
[Public Demo data notice](data-and-safety.md#public-demo).

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

The local authorities are `jobctrl.db` (profile, jobs, Discovery controls, events and
projections), bundled `temporal.db`, `config.json` (non-secret Settings
values), `.env` and `gmail/` (legacy/runtime credentials), `codex_home/` and provider-runtime
directories, generated material/log directories, browser capability/profile/
worker state, `backups/`, and legacy resume inputs. Their text may still be sent
when an explicitly used model or external integration needs that content;
configured telemetry remains metadata-only.

Browser-adoption metadata is stored in `config.json`, while copied browser
profiles and the extension pairing token remain separate protected artifacts.

::: warning Local does not mean encrypted
JobCtrl does not encrypt `jobctrl.db`, `.env`, or generated artifacts. Protect
your OS account/disk and never attach `~/.jobctrl/` to a bug report.
:::

## Local API And Process Boundary

The product API binds to `127.0.0.1` by default. Every request must name a
loopback `Host` **and** arrive from a loopback peer address. Checking both
prevents a remote caller from passing the gate merely by forging a
`Host: 127.0.0.1` header and limits DNS-rebinding attacks from browser pages.

State-changing browser requests must also come from the first-party local web
ports and carry a trusted `Origin` or `Referer` plus acceptable
`Sec-Fetch-Site` metadata. Non-browser local clients need the local capability
token instead. Worker-backed actions fail with `worker_runtime_unavailable`
until the API sees a healthy worker heartbeat, so a dead or mismatched worker is
not mistaken for an executable product state.

These controls are locality enforcement, not user authentication. Deliberately
binding the API to a non-loopback interface changes the threat model and is not
a supported substitute for hosted authentication, tenant authorization, and a
managed secret store.

## Browser Extension Pairing

The extension uses a local capability token for `/v1/extension/*` loopback
routes. Settings can display/rotate it only from the CLI or same-origin Settings
surface. The token does not make a remote API bind safe.

The app directory is created with owner-only permissions and the token file is
written with mode `0600`. Rotation replaces the token immediately and
disconnects existing extension clients. An extension-origin request can use a
valid token for its scoped routes, but it cannot read, mint, or rotate the token
itself.

Capture requires a click and sends the active page URL/visible text to the local
API. If the stack is down, the extension holds a bounded local queue. Autofill
reads only whitelisted profile fields on supported ATS hosts, shows a review
panel, and never calls submit. Passwords, resume content, and generated free-text
answers are excluded.

## Outbound Destination And Sensitive-Tool Binding

JobCtrl treats URLs from postings, redirects, captured pages, and model output
as untrusted. Its shared public-destination guard resolves the target and accepts
only public HTTP(S). It blocks loopback, private-network, link-local, reserved,
unspecified, multicast, cloud-metadata, `file:`, and other non-web targets.
Discovery detail rendering, smart extraction, enrichment, authenticated
LinkedIn resolution, contact research, and apply launch validate their relevant
initial, redirect, final-page, popup, or subrequest boundaries instead of
trusting the first URL once.

The two most sensitive browser tools have an additional destination binding:

- `type_credential` reads the password locally, verifies that the active page
  origin is one derived from the approved application URL, confirms the focused
  element is a password field, and then types the secret without returning it to
  the model;
- `upload_artifact` resolves only the reviewed resume or cover letter, requires
  a live file input on the current page, and rejects and records an upload when
  the page origin differs from the approved application origin.

These checks limit the impact of a malicious page or prompt injection that
tries to navigate elsewhere before requesting a password or file upload.

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

### Repeat Applications Fail Closed

Every live claim also re-evaluates repeat-application evidence at the Python
worker boundary. A confirmed application to the same canonical job or an
accepted duplicate identity blocks by default. A confirmed application to the
same employer and a conservatively equivalent role requires explicit
confirmation. Distinct roles and merely similar employer names remain eligible.

The evidence can come only from canonical job identity and confirmed application
facts. Pending email suggestions, notes, dry runs, failed pre-submit attempts,
submit intent without confirmation, and assumptions are excluded. Apply Review
exposes the prior application, relationship reason, identity evidence, and
audit trail rather than presenting an unexplained warning.

An override records the intended target, selected prior application, current
evidence fingerprint, actor, reason, and timestamp. The worker consumes it for
one run while holding the same `BEGIN IMMEDIATE` claim transaction; a stale or
already-consumed override fails closed. This guard applies even when per-job
approval is disabled and cannot be bypassed by a direct API/RPC request, the
standing loop, a stale UI, or concurrent claims. Approval binding, submit intent,
at-most-once claiming, and `needs_verification` remain separate required gates.

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

The Settings read path may detect supported Chrome/Chromium installations, but
it returns only a bounded ID and label. Detection never launches, adopts,
copies, or persists a browser and never returns its path. Adoption is a
separate explicit mutation selecting either the current detected ID or a
write-only executable path. Detected IDs are revalidated at adoption time; a
stale ID fails closed rather than silently selecting another installation.

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

Anonymous discovery/enrichment uses one gateway for controlled HTTP and
Playwright fetches:

- `robots.txt` is enforced for page rendering: `2xx` parses the file, `4xx`
  means absent, `5xx`/timeout is inconclusive and fails closed, and definitive
  network absence fails open with a warning;
- targets, redirects, and subrequests must be public HTTP(S)—loopback, private,
  link-local, metadata, and file URLs are blocked;
- per-host pacing, concurrency, and per-run request budgets limit load;
- one honest JobCtrl user agent is used instead of browser impersonation; and
- denied/rate-limited/budget/unsafe destinations are recorded as outcomes, not
  generic scrape errors.

JobStreaming owns its internal board transports, so JobCtrl can apply only
invocation-level pacing/budget there. Authenticated LinkedIn is an explicit
owner-session carve-out: only after browser capability enablement and separate
profile-copy consent may it recover the full posting and external application
URL without applying the anonymous robots verdict. Public-destination checks,
per-host pacing, the shared run budget, and audit history still apply, and the
recovery path cannot submit an application. See
[Discovery → Crawl Politeness](discovery.md#crawl-politeness).

## Credentials

Codex-backed work requires an authenticated Codex CLI before JobCtrl can reuse
or verify that login.

| Secret | Boundary |
| --- | --- |
| Provider/runtime keys | Shell, plaintext `~/.jobctrl/.env`, or the guided macOS Keychain boundary; never SQLite. |
| Codex login | Stable `$JOBCTRL_DIR/codex_home/auth.json`, separate from SQLite and the normal Codex home. Valid normal CLI auth may be reused once only when this file is absent; existing isolated auth is never overwritten. Prompt-driven reads are limited to `codex_home/workspace/` plus the exact canonical Codex executable required to start the app server—not its package directory or sibling files. |
| Claude/Google web entries | Keychain for API keys plus cloud activation flags/non-secret identifiers; AWS, Google, and Azure credential files remain in their vendor stores. Status only is returned. |
| CAPTCHA key | `CAPSOLVER_API_KEY` saved from Settings to Keychain on macOS, or supplied by the environment elsewhere; read by the owned local solver, not the model. |
| Job-site passwords | Optional local profile value typed through a focused-field credential tool, never returned to the model. |

`config.json` contains non-secret Settings values and is replaced atomically
with owner-only mode `0600`. The extension capability token is also `0600`.
This limits accidental access by other local accounts, but it is not encryption
and does not protect against a compromised user account.

Environment values win over Keychain and make the matching Settings control
read-only. Keychain is loaded only for missing/empty values at process startup,
so restart the relevant Python process after Claude, Google, or CapSolver
changes. Codex verification, model preference, browser capability, and
extension-pairing changes do not require that restart. Provider
replacement is atomic from the web contract; stored secrets are used internally
only to restore a failed batch and never cross the HTTP boundary. Windows and
Linux use environment configuration today.

## Runtime And Supply-Chain Boundary

Bundled mode fails closed around its installed payload. The launcher supplies an
absolute payload root; the API resolves its Python, web, and browser paths and
rejects paths outside that tree. Python starts in isolated mode, ignores ambient
`PYTHONHOME`, `PYTHONPATH`, virtual environments, and user-site packages, and
does not search a checkout for dotenv files.

Provider runtimes that cannot ship in the core payload are installed from the
payload-owned provider-pack lock. JobCtrl accepts only the exact locked wheel
closure from the official HTTPS wheel host, checks size and SHA-256, rejects
unsafe, encrypted, escaping, or overlapping archive members, and retains the
source wheels. Activation revalidates those bytes, deterministically derives
the expected installed tree, and compares it with the live provider pack before
executing it.

The native supervisor verifies the payload manifest and tree before dispatch
and records process identity, executable, build identity, manifest digest, and
ports so cleanup cannot target a recycled PID. Promotion of public bundled
artifacts also requires the repository privacy scan, signing, and notarization;
the scan rejects secret assignments, private-profile needles, browser profiles,
databases, resumes, tokens, logs, and other blocked user artifacts.

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

## Content Integrity And Auditability

Job postings, imported documents, page text, and all model responses are
untrusted inputs. JobCtrl uses structured schemas and deterministic validation
before model output becomes a score, employer analysis, resume, cover letter,
or application answer. Employer-analysis evidence spans must exist literally in
the captured posting. Resume and cover-letter gates reject unsupported numbers,
dates, titles, employers, skills, and tools; rendered-text coverage and
provenance are computed from the actual selected artifact rather than inferred
from the prompt.

Judge and adversarial review add another integrity layer, but deterministic
grounding remains authoritative. When regeneration or review fails, JobCtrl
keeps the last accepted artifact visible and records the failed attempt instead
of replacing or hiding known-good material. Approval decisions, submit intent,
provider failures, residual warnings, terminal outcomes, and verification parks
remain inspectable in the local event/read model so the UI can explain what
happened and which evidence was used.

## Scoring Is Applicant-Side Only

Fit scores help the applicant prioritize. They are not employer-side screening
and must not rank people for hiring without separate legal, bias-audit,
validation, notice, and human-review controls.

## Reporting A Security Issue

Prefer GitHub private vulnerability reporting. Otherwise request a private
contact path in a minimal public issue; omit exploit details, secrets, logs,
profiles, artifacts, and local paths. See [SECURITY.md](../../SECURITY.md).
