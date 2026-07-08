---
pageClass: jh-user-guide-page
next: false
---

# Security

JobCtrl runs entirely on your machine. There is no hosted backend, no account,
and no server that receives your job-search data. The trust boundary is your own
computer: the local SQLite database, generated resumes and cover letters, browser
profiles, logs, and credentials all live under `~/.jobctrl/` and stay there
unless a step you run explicitly sends something to an external service. This
page describes what those steps are, the approval gates that guard risky actions,
and the honest limits of running everything locally.

This page owns JobCtrl's threat model and safety gates. For the full inventory
of what is stored locally and how to share bug reports safely, see
[Data, Privacy & Safety](data-and-safety.md).

## Privacy Quick Answer

Local-first means JobCtrl stores your database, browser state, generated
resumes, cover letters, logs, and credentials on your own computer. It does not
mean every character stays local forever: LLM providers, the apply agent,
Gmail, Google Maps, CAPTCHA solving, and Langfuse receive data only when you
configure and run the specific step that needs them.

## What Leaves Your Machine

Nothing leaves your machine by default. The following calls happen only when you
run the step that needs them and have configured the relevant provider:

| Outbound call | When it happens | What is sent |
| --- | --- | --- |
| LLM provider APIs | Scoring, employer analysis, resume tailoring, and cover-letter generation | Job posting text, your profile evidence (experience, skills, verified metrics), and the generated resume/cover-letter text. Employer analysis sends the posting text to a Claude, Codex, and Gemini ensemble. |
| The apply agent's model | Only when you run apply or dry-run | The full apply prompt: your profile summary (contact details, work authorization, salary expectation, EEO answers) plus the tailored resume and cover-letter text. Profile passwords and CAPTCHA-provider keys are not included in the prompt. The apply agent is a local Claude runtime subprocess (system `claude` or the pinned SDK-bundled binary), so this prompt is sent to the model backing it. |
| Job boards, ATS APIs, and posting pages | Discovery and enrichment | Search queries and page fetches. JobCtrl never bypasses login, paywall, CAPTCHA, rate-limit, or bot-control gates (see [No Third-Party Bypass](#no-third-party-bypass)). |
| Gmail | Only if you authenticate the Gmail connector | Bounded search queries for verification codes and application-outcome emails, plus approved email application sends. Raw email bodies stay local and are not copied into events, telemetry, broad projections, or logs; outgoing sends require `gmail.send` and a matching Apply Review binding. |
| Google Maps | Only if you set `VITE_GOOGLE_MAPS_API_KEY` | Address text you type into the Profile form's location search. |
| CAPTCHA solving service | Only when `CAPSOLVER_API_KEY` is configured and a supported apply-page widget is detected | The owned local solver tool sends the site key and page URL to the configured provider; provider keys and solver tokens are not sent through the model prompt. Unsupported or unconfigured CAPTCHA flows fail closed. |
| Langfuse / OpenTelemetry | Only if you configure Langfuse credentials | LLM prompts and completions, workflow spans, and JSON-RPC spans. Export is off unless configured, and `LANGFUSE_DISABLE=1` opts out even when credentials are present. |

The apply prompt is the largest single batch of personal data that leaves your
machine. Review dry-run transcripts and keep targets narrow before any live
submission.

## What Stays On Your Machine

JobCtrl never uploads these files anywhere — they exist only on your disk:

- the `jobctrl.db` SQLite database (profile, jobs, events, projections,
  settings, artifact metadata, and its `-wal` / `-shm` sidecars);
- generated resume, cover-letter, and PDF files;
- browser profiles and apply-worker state;
- raw Gmail message bodies;
- local logs and locally written prompt/completion traces.

Files staying local is not the same as their *content* staying local: the text
of a tailored resume or cover letter necessarily passes through the LLM
provider that generates it, is included in the apply prompt, and appears in
Langfuse traces if you enabled that export — exactly the rows in the table
above. If you configured no external provider, nothing in this list leaves in
any form.

::: warning Local data is not encrypted
JobCtrl does not encrypt the database, the `.env` file, or generated
artifacts, so their protection is your operating-system account and disk
security. Treat `~/.jobctrl/` as sensitive: do not commit it, copy it into
shared locations, or attach it to bug reports.
:::

## Browser Extension Pairing

The browser-extension API surface uses a local capability token so an installed
extension can prove it is paired with your local JobCtrl stack. The token is
generated under `~/.jobctrl/`, shown in Settings for pairing, and only
accepted on `/v1/extension/*` routes that still target a loopback host. It does
not grant application-submission authority; live submission remains behind
Apply Review.

In Phase 1, the extension can only capture the active http(s) page after you
click **Save job** in the popup. It sends the page URL and visible text to the
local API over loopback, where JobCtrl records it through the same
manual-capture importer used by the web app. If the local stack is down, the
extension keeps a bounded local queue in browser extension storage. It does not
send captures to third-party services and it has no submit/apply action.

In deterministic autofill mode, the extension reads only a whitelisted profile
field list from `/v1/extension/autofill/profile`; password and resume content
are excluded. Content scripts are limited to supported ATS hosts and show a
review panel before filling accepted values. The extension code does not call
form submit, `requestSubmit`, or an apply route.

## Approval And Control Gates

Applying to jobs is JobCtrl's one genuinely risky action, because it can drive
a real browser and submit a real application. Several gates stand between a
discovered job and a submitted one. In plain terms: you rehearse the application
with a dry run before live submission, nothing is submitted for real until you
explicitly approve that exact job with current evidence, and the same application
is never submitted twice.

### Apply Approval Is Required By Default

Live submission is gated on an explicit decision. With the default
`applyApprovalRequired: true`, a live apply run starts only when the latest Apply
Review decision for that job is `approve_submit`, that approval is bound to the
current materials generation, profile version, and application URL, and matching
dry-run evidence exists. Full dry-run evidence satisfies the gate. A partial dry
run satisfies it only when you use the explicit partial-evidence approval action
for that specific run. Otherwise the backend claim rolls back and the browser
never launches. The gate is enforced in the worker's claim transaction, not
merely surfaced in the UI, so no UI or command path can submit without a fresh
recorded approval while the gate is on. You can turn the gate off in Preferences,
which is why the settings form shows a persistent warning when it is off — with
the gate off, the agent may submit immediately after claiming a job.

Email-only application paths still use this approval model. During dry-run, the
agent may report a posted recipient with `RESULT:EMAIL_ONLY:<address>`, but it
does not draft or send email. JobCtrl verifies that recipient against stored
posting text, records a deterministic candidate with the selected resume PDF
attachment, and sends through Gmail only when Apply Review approves that exact
recipient and attachment. A stale binding, missing `gmail.send` token, or missing
sender parks or fails closed instead of sending.

### Dry-Run Cannot Submit

Run dry-runs before approving any real submission. Dry-run does two things, so
that safety does not depend on the agent choosing not to click submit:

- it tells the agent not to click the final Submit/Apply button; and
- it installs a guard inside the browser itself — over the Chrome DevTools
  Protocol — that blocks mutating requests, form submits, WebSocket/beacon
  channels, and script or subresource `GET`/`HEAD` requests that could carry
  filled profile data out through an image, fetch, or similar page-controlled
  channel. Ordinary document navigation remains available so the rehearsal can
  still reach the application page. Even a misbehaving agent physically cannot
  submit a form through the browser during a dry run.

Dry-run submits nothing, so it does not require an approval decision.

### Applications Submit At Most Once

JobCtrl is built so that a job is never submitted twice, even if something
crashes mid-apply. Before it starts, an apply run refuses to claim a job that
already has a run in progress, succeeded, or parked for verification. The agent
records a "submit intent" checkpoint just before it submits; if the process then
crashes without a clear result, the run is parked for you to verify by hand
instead of being retried. A missed retry is safer than a duplicate application.

### Daily LLM Spend Ceiling

A daily budget (`dailyBudgetUsd`, default `25`; `0` means unlimited) caps LLM
cost. Every workflow that spends LLM tokens runs a budget preflight and stops
with a non-retryable budget error once the day's estimated spend reaches the
ceiling. The ledger is a coarse estimate, not billing truth, and the ceiling is a
per-workflow preflight rather than a mid-call interrupt: a run already in flight
is not aborted, but the next spendful workflow will not start. Today's estimated
spend against the budget is shown on the health surface. See
[Configuration](configuration.md#llm-spend-budget).

### No Third-Party Bypass

JobCtrl must never submit applications, run destructive profile or database
actions, or bypass third-party controls unless you explicitly authorize that
behavior. This includes CAPTCHA, paywall, login, rate-limit, and bot-control
bypass. The apply agent is instructed to stop on single sign-on and third-party login
screens (SSO/OAuth), decline browser permission prompts, refuse ID or biometric
verification, and never enter payment or bank details. CAPTCHA solving is limited
to the owned local solver tool for supported widgets; unsupported or unconfigured
challenges fail closed.

### Crawl Politeness

Every discovery and enrichment fetch — `urllib` API calls and Playwright
navigations alike — routes through one crawl-politeness gateway. It:

- **Honors `robots.txt`** for page-rendering fetches, following owner decision
  D6 when the file cannot be read: a `2xx` is parsed and enforced; a `4xx`
  (including `404`) means the file is genuinely absent, so the fetch is allowed
  (per RFC 9309); a `5xx` or a timeout is *inconclusive* and fails **closed** —
  the path is treated as disallowed and re-checked on a short TTL; and a DNS
  failure or a refused connection is a *definitive network absence* of the robots
  endpoint and fails **open with a warning** (allow), since a genuinely down host
  simply fails the follow-on content fetch harmlessly. The trade-off this accepts
  is that a host which refuses `/robots.txt` while still serving content is
  crawled unenforced. JobCtrl also uses the standard-library `robotparser`,
  which is first-match rather than RFC 9309 longest-match, so it can over-block an
  `Allow` exception — the safe direction.
- **Stamps one honest `User-Agent`** — `JobCtrl/<version> (+<repo url>)` by
  default — that **never impersonates a browser** on a surface it controls. You
  can override the product token and contact via
  [configuration](configuration.md#crawl-politeness); review it before real
  crawls.
- **Paces requests per host** (a minimum interval + a concurrency cap) and
  **bounds each run's request budget**, so parallel crawls cannot hammer a host.
  A server `Retry-After` is honored but clamped, so a hostile header cannot
  freeze a worker.

A blocked fetch is recorded as a first-class **outcome** — robots-disallowed,
rate-limited, or budget-exhausted — never a scrape error, and is surfaced per
source in the Source Health card (`SourcePolitenessBadges`) and discovery
controls. Broad job boards fetched through `python-jobspy` own their internal
per-board transport, so JobCtrl cannot robots-gate those individual requests;
it applies budget + pacing at its own invocation boundary, and `jobctrl
doctor` discloses when broad boards are active. The authenticated LinkedIn path
uses your own logged-in browser session and presents its real browser identity —
an owner-scoped exception that is still rate- and budget-limited.

## Credentials

Different secrets live in different places, and it is worth knowing which:

- **LLM provider keys** (OpenAI, Gemini, and a local LLM endpoint) can be stored
  in the macOS Keychain through the web app's credential store, or in
  `~/.jobctrl/.env`. When stored in the Keychain they are never written to
  SQLite, logs, traces, or artifacts.
- **The CapSolver key** is the `CAPSOLVER_API_KEY` environment variable
  (`.env`). The apply agent does not receive this key in its model prompt; the
  owned solver tool reads it locally and never returns provider keys or solver
  tokens to the model.
- **Account passwords for login autofill** are profile data if you store them,
  but the apply agent does not receive profile passwords in its prompt. For a
  regular job-site password field, it can call a local credential tool that
  reads the password from the local profile database and types it into the
  focused field without returning the value to the model. If the credential is
  missing or the field is not a password field, login fails closed for operator
  handling.

JobCtrl never commits any of these; the release gate scans for accidental
secret commits (see the [developer Security page](../developer/security.md)).

## The Apply Agent

The apply agent is a local Claude runtime subprocess that drives a real Chrome
browser through Playwright. It uses a system `claude` when present, then the
pinned Claude Agent SDK bundled binary unless `JOBCTRL_CLAUDE_BIN` is set. It
runs with an explicit MCP tool allowlist for apply automation: browser form
tools plus bounded Gmail verification-code tools, not shell/file access, raw
Gmail mailbox send tools, raw page-script evaluation, or broad permission
bypass. Email-only applications are sent by JobCtrl's owned Gmail connector
after Apply Review approval, not by an agent mailbox tool.

::: warning Prompt injection is a real risk
Because the agent reads live, untrusted job pages and acts on them, a malicious
page could try to trick it into doing something you did not intend. The controls
below limit the damage; they do not remove the risk.
:::

Those controls:

- the dry-run guard inside the browser makes it impossible to submit a form off
  your machine during a dry run;
- the approval gate keeps live submission behind a fresh `approve_submit`
  decision bound to the reviewed materials, profile, URL, and dry-run evidence;
- the spend ceiling caps how much LLM cost a runaway loop can incur;
- credentials stay local — the LLM keys are not in the page's reach, and Gmail
  write tools (draft, send, delete, modify, label, filter) are explicitly
  disallowed for the agent;
- the prompt hard-rules tell the agent never to lie about work authorization or
  background, never to grant camera/mic/location permissions, and never to enter
  payment details.

Keep targets narrow and review dry-run transcripts before any live submission.
If a required legal or screening attestation is missing from the profile, the
agent stops instead of guessing.

## Scoring Is Applicant-Side Only

Fit scores are a triage aid for you, the applicant. They are not employer-side
candidate screening and must not be used to rank people for hiring without a
separate legal, bias-audit, validation, notice, and human-review process.

## Reporting A Security Issue

Report vulnerabilities privately. Prefer GitHub private vulnerability reporting
if it is enabled for the repository; otherwise open a minimal public issue asking
for a private contact path, and omit exploit details, secrets, logs, profile
data, generated materials, and local paths. The full policy is in
[SECURITY.md](../../SECURITY.md).
