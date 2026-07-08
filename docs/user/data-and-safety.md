---
pageClass: jh-user-guide-page
---

# Data, Privacy & Safety

The short version: your job-search data stays on your machine. Your profile,
jobs, generated resumes and cover letters, logs, and browser state all live in a
folder under your home directory, and nothing leaves your computer unless you run
a step that needs an external service. This page lists what is stored locally,
what can leave, and which actions to treat with care.

## Privacy Quick Answer

JobCtrl has no hosted backend and no account system. Your database and files
stay local by default. Privacy-sensitive content can still leave your machine
when you deliberately run steps that need outside services: LLM calls, job-board
fetches, Gmail lookups or approved email application sends, Google Maps
autocomplete, CAPTCHA solving, or Langfuse telemetry when configured. Live apply
automation and email-based application sending are real employer-facing actions,
not simulations.

## Local Data

Default local directory:

```text
~/.jobctrl/
```

Common files and directories:

| Path | Contents |
| --- | --- |
| `jobctrl.db` | SQLite database with profile, jobs, events, projections, settings, artifacts, review drafts, contacts, and workflow state. |
| `.env` | Provider keys and runtime settings. |
| `tailored_resumes/` | Generated resumes and related HTML/PDF outputs. |
| `cover_letters/` | Generated cover letters. |
| `logs/` | Local worker and apply logs. |
| `chrome-workers/` | Browser profiles and state for local browser tasks. |
| `apply-workers/` | Apply-run worker state. |
| `codex_home/` | Isolated SDK state used by local agent integrations when configured. |
| `backups/` | Timestamped SQLite snapshots written by `jobctrl backup`; restore steps are in the README. |
| `resume.txt`, `resume.pdf`, legacy `resume_style.json`, legacy `resume_template.tex` | Baseline resume inputs and older local style/template files that may remain from prior installs. |
| `gmail/` | Gmail OAuth client and token (`oauth-client.json`, `token.json`). |
| `jobctrl.db-wal`, `jobctrl.db-shm` | SQLite write-ahead sidecars; treat them as part of the database. |

The development launcher also writes PIDs and process logs under the repo's
`.dev/` directory — treat those logs as sensitive too.

Contact records you keep — recruiter, hiring-manager, and referrer names, emails,
phone numbers, and notes — are stored only in that local `jobctrl.db`, and each
fact is tagged with its provenance (where it came from). Their values never appear
in the event log, read-model projections, logs, or telemetry, and JobCtrl never
sends anything to a contact: it keeps records only, with no email, message, or
outreach sending.

**Supervised contact research** is conservative and opt-in. It only ever looks at
three source kinds: what you type, a list you import, and a public web page you
explicitly point it at. No public page is fetched automatically — you supply each
URL, and JobCtrl fetches it politely (respecting the site's `robots.txt` and
rate limits) through its one shared fetch path. Any login-walled, paywalled, or
bot-protected page is never auto-fetched — it is routed to a manual-capture step
instead. Research only **proposes** contacts for your review; nothing it finds
becomes a stored contact until you explicitly confirm it, and every proposed fact
shows its source. It still never sends anything, and research data never affects
scoring or apply decisions.

**Outreach drafts** are generated under the same anti-fabrication discipline as
your resumes and cover letters: every draft is checked against your profile and the
confirmed contact record, and a draft that invents a metric, employer, or
relationship is blocked from approval. Drafts are yours — the message body, its
gate results, and its provenance stay in the local `jobctrl.db` and never enter
the event log, projections, logs, or telemetry. A draft terminates at
**copy/export**: there is no send transport of any kind, so you send every message
yourself through your own channel.

**Logging a send** is a record you enter, not an action JobCtrl takes. After you
have sent an approved draft yourself, you can note the date and the channel you
used; that is the only way a thread is ever marked "sent". JobCtrl never sends
and has no send capability — the send-log records a fact. The logged event stores
only ids, the channel label, and timestamps; it never stores a contact's name or
email. **Follow-ups** are surfaced-only reminders: JobCtrl suggests a
conservative next date you can edit, shows it when it is due, and never acts on it
or sends it. Any optional recurring follow-up reminder is off by default. Send and
follow-up data are advisory and never affect scoring or apply decisions.

::: warning Never commit your local data
Do not commit `~/.jobctrl/` (or the repo's `.dev/` logs), or any copy of those
files. They hold your database, provider keys, and generated resumes and cover
letters.
:::

## External Services

Depending on configuration, JobCtrl can call:

- LLM providers for scoring, employer analysis, tailoring, cover letters, and
  stored interview prep;
- job boards, ATS APIs, or public posting pages for discovery and enrichment;
- Gmail APIs for verification-code or outcome feedback flows, plus approved
  email application sends when the dry-run candidate and Apply Review approval
  bind the same recipient and attachment;
- Langfuse/OpenTelemetry endpoints for traces when explicitly enabled;
- paid CAPTCHA solving services when explicitly configured for apply automation.

Review configuration before running large pipelines.

Discovery and enrichment fetches go through one crawl-politeness gateway that
honors `robots.txt` (failing closed on an inconclusive fetch — a `5xx` or timeout
— but failing open with a warning when the host has no robots endpoint at all — a
DNS failure or refused connection), paces requests per host, bounds each run's
request budget, and stamps a single honest
`User-Agent` — `JobCtrl/<version> (+<repo url>)` by default, never a spoofed
browser. Direct targets, redirects, and Playwright subrequests must be public
HTTP(S) destinations; loopback, private, link-local, metadata-service, and file
URLs are blocked before content extraction or LLM enrichment. Blocked fetches
become recorded outcomes (robots-disallowed / rate-limited / budget-exhausted /
unsafe-url), not scrape errors. See
[Security → Crawl Politeness](security.md#crawl-politeness) for the full posture
and [Configuration → Crawl Politeness](configuration.md#crawl-politeness) to
review or override the user-agent.

## Responsible Use Boundaries

These boundaries are the operator's responsibility:

- **Live employer submissions:** apply automation can submit real applications
  to real employers. Keep `applyApprovalRequired` enabled unless you have a
  specific reason to disable it, rehearse with dry runs, and target one job or
  site at a time while validating behavior.
- **Email applications:** sending an application by email is still a live
  employer submission. JobCtrl sends only through the owned Gmail connector
  after a dry-run records the recipient and attachment candidate and Apply
  Review approves that exact binding; without Gmail `gmail.send` or a matching
  approval, the path fails closed.
- **Credential typing:** browser automation can type non-secret profile fields.
  For regular job-site password fields, the apply agent can call a local
  credential tool that reads the stored profile password and types it into the
  focused field without returning the value to the model. If the tool is
  unavailable or the focused field is not a password field, login fails closed
  for operator handling.
- **CAPTCHA solving:** supported CAPTCHA widgets are handled only through the
  owned local solver tool when configured. The apply agent does not solve
  image/audio challenges manually, switch to stealth browsers, or receive a
  CAPTCHA-provider key or solver token through the model prompt. Unsupported or
  unconfigured CAPTCHA flows fail closed.
- **Scraping and source terms:** source access can violate provider or site
  terms. Default discovery options include LinkedIn and Indeed; disable any
  source you are not allowed to query automatically.
- **Local API exposure:** the TypeScript API is intended for loopback use. The
  default host is `127.0.0.1`; opting into a non-loopback bind or exposing it
  through a tunnel can expose private profile, job, artifact, and
  credential-adjacent metadata. Browser-extension routes add a local capability
  token stored under `~/.jobctrl/`, but that token does not make a remote bind
  safe.
- **Browser-extension captures:** the optional extension stores its pairing
  token and any stack-down capture queue in browser extension storage. Queued
  captures contain page URLs and visible posting text, expire under the
  extension's bounded local policy, and are cleared when you save a new pairing
  token.
- **Browser-extension autofill:** supported ATS pages receive only the
  whitelisted profile fields needed for deterministic suggestions. Profile
  passwords, resume bullets, generated materials, and free-text answer drafts
  are not sent to the extension autofill route.
- **AI spend:** LLM calls can cost money. The local `dailyBudgetUsd` ceiling
  gates new spendful workflows, but it is an estimate and does not replace your
  provider-side billing controls.
- **Interview prep:** JobCtrl can generate stored pre-interview notes for a
  job from grounded profile/job/material evidence. Post-interview reflection
  notes can be linked to an accepted prep generation, but they stay local manual
  outcome notes. JobCtrl is not a live interview assistant and has no
  transcript upload, microphone input, streaming, websocket, in-session state, or
  real-time answer surface.

## Auto-Apply Safety

Apply automation can submit real applications to real employers, so it is
guarded by approval gates: a rehearsal dry run before live submission, an
explicit approval bound to the reviewed materials generation, profile version,
and application URL, a browser-level guard during dry runs, no application
submitted twice, and a daily spend ceiling. Apply Review allows a partial
dry-run override only when it names the specific partial run and shows the
blocked channels you are accepting. Email-only applications use the same
approval model: the agent can report the posted recipient, but JobCtrl records
the deterministic email candidate locally and sends only after approval binds
that recipient and attachment. The apply agent also reads untrusted job pages,
so prompt injection is a real exposure. The full gate model, the apply agent's
automation posture, and how credentials appear in the apply prompt live in
[Security](security.md).

Two guarantees stay here because they are about your local artifacts:

- manual outcomes, including interview-prep reflections, can be recorded without
  browser automation, and web approval facts do not submit by themselves;
- failed refreshes or invalid edited drafts must not destroy current accepted
  materials.

::: warning Applying is irreversible
Never run auto-apply against broad targets until you have verified your profile
data, materials, field mapping, account state, and site-specific behavior. Once
an application is submitted, you cannot undo it.
:::

## Scoring Safety

Scores are applicant-side triage aids. They are not employer-side candidate
screening or hiring decisions. Do not use JobCtrl to rank people for hiring
without separate legal, bias-audit, validation, notice, and human-review
processes.

## LLM Spend Ceiling

LLM usage is metered locally. A daily budget (`dailyBudgetUsd`, default `25`;
`0` means unlimited) gates every workflow that spends LLM tokens: a budget
preflight runs before the heavy activity and stops the workflow with a
non-retryable budget error once the estimated daily spend reaches the
ceiling. Current spend versus budget is visible on `GET /v1/health` and in
the web app's health surface. This ceiling controls JobCtrl workflow starts;
it is not the provider's bill and it does not stop provider usage outside
JobCtrl.

## Telemetry

Langfuse export is off unless configured. If enabled, LLM prompts and
completions are exported to the configured Langfuse instance. Set
`LANGFUSE_DISABLE=1` to opt out even when credentials are present.

## Public Bug Reports

Use synthetic data only. Do not include:

- real resumes or profile fields;
- real job-search databases;
- API keys or OAuth tokens;
- generated PDFs or cover letters;
- local filesystem paths;
- raw logs or prompt/completion traces.

`pnpm qa:seed` creates a disposable synthetic workspace that is safe for
screenshots and bug reproduction.

`scripts/release_check.py` is the enforcement gate behind these rules: CI runs
it on every push and pull request to scan the tree for real-profile needles,
secrets, prompt tripwires, blocked file types, and blocked distribution paths
before anything is published.
