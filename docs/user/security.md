# Security

JobHunter runs entirely on your machine. There is no hosted backend, no account,
and no server that receives your job-search data. The trust boundary is your own
computer: the local SQLite database, generated resumes and cover letters, browser
profiles, logs, and credentials all live under `~/.jobhunter/` and stay there
unless a step you run explicitly sends something to an external service. This
page describes what those steps are, the consent gates that guard risky actions,
and the honest limits of the current local-only posture.

This page owns JobHunter's threat model and safety gates. For the full inventory
of what is stored locally and how to share bug reports safely, see
[Data & Safety](data-and-safety.md).

## What Leaves Your Machine

Nothing leaves your machine by default. The following calls happen only when you
run the step that needs them and have configured the relevant provider:

| Outbound call | When it happens | What is sent |
| --- | --- | --- |
| LLM provider APIs | Scoring, employer analysis, resume tailoring, and cover-letter generation | Job posting text, your profile evidence (experience, skills, verified metrics), and the generated resume/cover-letter text. Employer analysis fans the posting text out to a Claude + Codex + Gemini ensemble. |
| The apply agent's model | Only when you run apply or dry-run | The full apply prompt: your profile summary (contact details, work authorization, salary expectation, EEO answers), the tailored resume and cover-letter text, and — when you have configured them — an account password for login fields and the CapSolver API key. The apply agent is a Claude Code CLI subprocess, so this prompt is sent to the model backing it. |
| Job boards, ATS APIs, and posting pages | Discovery and enrichment | Search queries and page fetches. JobHunter never bypasses login, paywall, CAPTCHA, rate-limit, or bot-control gates (see [No Third-Party Bypass](#no-third-party-bypass)). |
| Gmail (read-only) | Only if you authenticate the Gmail connector | Bounded search queries for verification codes and application-outcome emails. The connector requests read-only scope; raw email bodies stay local and are not copied into events, telemetry, broad projections, or logs. |
| Google Maps | Only if you set `VITE_GOOGLE_MAPS_API_KEY` | Address text you type into the Profile form's location search. |
| CAPTCHA solving service | Only if you set `CAPSOLVER_API_KEY` and run a live apply | CAPTCHA site keys and page URLs, so an authorized apply run can clear a challenge on a site you chose to apply to. |
| Langfuse / OpenTelemetry | Only if you configure Langfuse credentials | LLM prompts and completions, workflow spans, and JSON-RPC spans. Export is off unless configured, and `LANGFUSE_DISABLE=1` opts out even when credentials are present. |

The apply prompt is the largest single egress of personal data. Review dry-run
transcripts and keep targets narrow before any live submission.

## What Stays On Your Machine

These never leave your machine and are never sent to any LLM or telemetry
endpoint:

- the `jobhunter.db` SQLite database (profile, jobs, events, projections,
  settings, artifact metadata, and its `-wal` / `-shm` sidecars);
- generated resumes, cover letters, and PDFs;
- browser profiles and apply-worker state;
- raw Gmail message bodies;
- local logs and prompt/completion traces.

Local data is stored **unencrypted** on disk. JobHunter does not encrypt the
database, the `.env` file, or generated artifacts, so their protection is your
operating-system account and disk security. Treat `~/.jobhunter/` as sensitive:
do not commit it, copy it into shared locations, or attach it to bug reports.

## Consent And Control Gates

JobHunter's risky action is applying to jobs, because it can drive a real browser
and submit a real application. Several gates stand between a discovered job and a
submitted application.

### Apply Approval Is Required By Default

Live submission is gated on an explicit decision. With the default
`applyApprovalRequired: true`, a live apply run starts only when the latest Apply
Review decision for that job is `approve_submit`; otherwise the backend claim
rolls back and the browser never launches. The gate is enforced in the worker's
claim transaction, not merely surfaced in the UI, so no UI or command path can
submit without a recorded approval while the gate is on. You can turn the gate
off in Preferences, which is why the settings form shows a persistent warning
when it is off — with the gate off, the agent may submit immediately after
claiming a job.

### Dry-Run Cannot Submit

Run dry-runs before approving any real submission. Dry-run does two things so
that safety does not depend on the agent choosing not to click submit:

- it tells the agent not to click the final Submit/Apply button; and
- it installs a browser-layer guard (over the Chrome DevTools Protocol) that
  blocks every non-loopback `POST`, `PUT`, and `PATCH` request and overrides form
  submits. Even a misbehaving agent cannot submit a form through the browser
  during a dry-run.

Dry-run submits nothing, so it does not require an approval decision.

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

JobHunter must never submit applications, run destructive profile or database
actions, or bypass third-party controls unless you explicitly authorize that
behavior. This includes CAPTCHA, paywall, login, rate-limit, and bot-control
bypass. The apply agent is instructed to stop on SSO/OAuth login walls, decline
browser permission prompts, refuse ID/biometric verification, and never enter
payment or bank details. When CapSolver is not configured, the agent is told not
to attempt CAPTCHAs at all.

## Credentials

Different secrets live in different places, and it is worth knowing which:

- **LLM provider keys** (OpenAI, Gemini, and a local LLM endpoint) can be stored
  in the macOS Keychain through the web UI's credential store, or in
  `~/.jobhunter/.env`. When stored in the Keychain they are never written to
  SQLite, logs, traces, or artifacts.
- **The CapSolver key** is the `CAPSOLVER_API_KEY` environment variable
  (`.env`), read only when you run a live apply.
- **Account passwords for login autofill** are only used if you put them in your
  profile. Unlike the LLM keys, a profile password is profile data, and — like
  the CapSolver key — it is interpolated into the apply agent's prompt when the
  agent hits a login form (see [The Apply Agent](#the-apply-agent) below). Only
  add a password to your profile if you accept that trade-off.

JobHunter never commits any of these; the release gate scans for accidental
secret commits (see the [developer Security page](../developer/security.md)).

## The Apply Agent

The apply agent is a local Claude Code CLI subprocess launched with
`--permission-mode bypassPermissions`, driving a real Chrome through Playwright
with no per-action permission prompts. It needs this autonomy to fill arbitrary,
unpredictable application forms. Because it reads untrusted third-party page
content live and acts on it, **prompt-injection exposure is real**: a malicious
job page could try to steer the agent.

Several controls bound the blast radius rather than eliminate the risk:

- the dry-run CDP guard makes it impossible to submit a form to a non-loopback
  host during a dry-run;
- the approval gate keeps live submission behind an explicit `approve_submit`
  decision;
- the spend ceiling caps how much LLM cost a runaway loop can incur;
- credentials stay local — the LLM keys are not in the page's reach, and Gmail
  write tools (draft, send, delete, modify, label, filter) are explicitly
  disallowed for the agent;
- the prompt hard-rules tell the agent never to lie about work authorization or
  background, never to grant camera/mic/location permissions, and never to enter
  payment details.

Keep targets narrow, review dry-run transcripts, and confirm the default
attestations the prompt supplies (18+: yes, felony: no) match your actual
situation before any live submission.

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
