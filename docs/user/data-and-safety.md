---
pageClass: jh-user-guide-page
---

# Data, Privacy & Safety

JobCtrl stores your working data on your computer. Network access happens only
when a feature you start—or a schedule you explicitly enable—needs a configured
external service.

This page owns the data inventory and responsible-use boundaries. For the
controls that enforce risky actions, read [Security](security.md). For exact
settings, read [Configuration](configuration.md).

## Privacy Quick Answer

| Question | Answer |
| --- | --- |
| Hosted backend or JobCtrl account required? | ✕ **No.** App, API, worker, database, and files run locally. |
| Database and generated files stored locally? | ✓ **Yes, by default.** They live under `JOBCTRL_DIR` (normally `~/.jobctrl/`). |
| Model or provider calls automatic? | ◐ **Only when used and configured.** Generation and opted-in research call providers during runs you start or schedules you explicitly enable. |
| Discovery makes network requests? | ◐ **Only when used.** Discovery contacts sources during runs you start or schedules you explicitly enable. |
| Telemetry enabled by default? | ✕ **No.** Langfuse requires configuration; `LANGFUSE_DISABLE=1` overrides it. |
| Discovery or enrichment may launch a browser? | ◐ **Only when needed.** Smart extraction and some detail enrichment use Playwright during runs you start or schedules you explicitly enable. |
| Application-submission browser automation always running? | ✕ **No.** It starts only through apply/dry-run work you initiate or a standing loop you explicitly enable. |
| Employer-facing submission or email send by default? | ✕ **No.** Browser submission and Gmail application sending are explicit guarded actions. |
| Outreach sends messages? | ✕ **No.** Drafts end at copy/export; send logs are user attestations. |

Local-first does not mean offline. Discovery fetches sources, generation calls
models, and live apply contacts an employer only when you use those features.

## Public Demo

The hosted synthetic demo is separate from the local product described above.
It can only be used after accepting first-party analytics cookies. Declining
returns to `https://jobctrl.dev`; opening the demo again shows the choice again.
The demo does not initialize its browser-local workspace until the consent
service confirms acceptance.

After acceptance, Cloudflare sets a versioned consent cookie plus random
HttpOnly visitor and session identifiers. The persistent cookies expire within
six months, the session cookie at the end of the browser session, and raw demo
events and non-linkable operational counters expire within 90 days. Events use
closed route/action/result categories: they exclude names, contact details,
profile or resume text, job/company content, URLs, searches, comments, local
paths, raw errors, and demo entity/workspace identifiers. IP addresses may be
used transiently by Cloudflare rate limiting but are not written to D1 or
application logs.

The demo contains synthetic data. Do not enter personal data, credentials, or
secrets. Post-accept withdrawal and immediate visitor-event deletion are not
yet available in this MVP; retained data expires on the schedules above. The
consent screen links to this disclosure before entry.

After entry, the compact **Demo guide** links to seeded scoring evidence,
tailored-material review, Apply Review/dry-run, and run history. Every shortcut
and action is simulated; it does not contact employers, send messages, or make
external changes. **Reset synthetic demo data** asks for confirmation, then
replaces the browser-local workspace with the original examples.
When a deployment changes the versioned synthetic seed, the next demo load
performs the same replacement automatically: it rotates the workspace identity,
clears pending simulated actions, and deletes generated demo blobs. This seed
refresh does not change the separate consent cookie or telemetry-retention
schedule.

## Local Data

Default workspace:

```text
~/.jobctrl/
```

Unless a row says otherwise, every path below is relative to JOBCTRL_DIR
(normally `~/.jobctrl/`).

| Path | Contents |
| --- | --- |
| `jobctrl.db` plus `-wal` / `-shm` | Profile, jobs, events, projections, settings, artifact metadata, review drafts, contacts, and workflows. Treat all three files as one database. |
| `temporal.db` plus `-wal` / `-shm` | Bundled-runtime Temporal state. During a native bundled update or rollback, it is hash-snapshotted and restored only together with `jobctrl.db`; never restore just one member of that pair. The bundled implementation exists, but the signed channel is not public until signing, notarization, publication, and clean-machine QA execute. |
| `.env` | Plaintext provider credentials and runtime settings. Not encrypted at rest. |
| `tailored_resumes/`, `cover_letters/` | Generated text, HTML, and PDF artifacts. |
| `logs/`, `apply-workers/`, `chrome-workers/` | Logs and local browser/apply state. |
| `codex_home/` | JobCtrl-owned integration state, isolated from the normal Codex app home. |
| `backups/` | Timestamped SQLite snapshots created by `jobctrl backup`. |
| `gmail/` | Gmail OAuth client and token files. |
| Baseline/legacy resume files | `resume.txt`, `resume.pdf`, and older local style/template files. |

The development launcher writes PIDs and logs under the checkout's `.dev/`
directory; treat those logs as sensitive too.

### Credentials Outside The Workspace

The web app exposes a macOS-only credential panel for `OPENAI_API_KEY`,
`GEMINI_API_KEY`, and `LLM_URL`. After environment-file loading, Python loads a
Keychain entry at startup only when that environment value is missing or empty.
Any non-empty environment value already present wins. Restart the worker (or the
full stack) after saving or removing a value.

Windows Credential Manager and Linux Secret Service/keyring adapters are
planned; those platforms use `.env` or shell variables today. The panel returns
status, never stored values. Unknown (`inspection_failed`) means Keychain could
not be inspected—not that a credential is absent. If Keychain is locked, unlock
it and retry.

::: tip Protected by default
The normal workspace is outside the repository. `.gitignore` and the release
privacy scan add safeguards. From a source checkout, use `corepack pnpm
qa:seed` for anything you intend to share.
:::

### Contacts And Outreach

Contact values and notes stay in canonical local tables. Events and broad
projections carry only IDs, kinds, counts, timestamps, and provenance metadata.

Contact research is supervised:

1. you provide or opt into a permitted source;
2. JobCtrl records the source attempt and proposes candidates;
3. you confirm a candidate before it becomes a contact.

Draft bodies, gate results, and claim provenance stay local. An approved draft
can be copied/exported; JobCtrl has no outreach send transport. Logging a send
records something you did. Follow-ups are reminders and never act automatically.

## External Services

| Service | When used | Data involved |
| --- | --- | --- |
| LLM providers | Scoring, employer analysis, materials, contact extraction, stored interview prep | Posting text, relevant profile evidence, generated text, or opted-in fetched page text. |
| Job boards, ATS APIs, posting pages | Discovery and enrichment | Search terms, URLs, and page/API requests. |
| Apply model and browser | Apply/dry-run work you start, or a standing loop you enable | Apply prompt, reviewed materials, profile application fields, and page interaction. |
| Gmail | Authenticated verification, bounded outcome feedback, or an approved email application | Scoped queries/evidence or the exact approved recipient/attachment. |
| Google Maps | Profile location autocomplete with a configured key | Address text typed into the location field. |
| CAPTCHA provider | Supported widget detected with a configured solver | Site key and page URL through the owned local tool. |
| Langfuse/OpenTelemetry | Explicitly configured telemetry | LLM, workflow, and JSON-RPC traces. |

Review [Security → What Leaves Your Machine](security.md#what-leaves-your-machine)
before enabling a provider.

## Responsible Use Boundaries

- **Employer actions are irreversible.** Rehearse with dry-run, review current
  materials and field mappings, and keep `applyApprovalRequired` enabled.
- **Email applications are live submissions.** They require a recorded
  recipient/attachment candidate and matching Apply Review approval.
- **Source access has terms.** Enable only job boards, feeds, and public pages
  you are allowed to query. JobCtrl does not authorize access for you.
- **CAPTCHA and login flows fail closed.** Unsupported challenges, identity or
  biometric checks, payment/bank prompts, and missing credentials require human
  handling.
- **The API is loopback software.** Binding it beyond `127.0.0.1` or tunneling
  it can expose private profile, job, artifact, and credential-adjacent data.
- **LLM spend is real.** `dailyBudgetUsd` limits new JobCtrl workflows based on
  a local estimate; keep provider-side billing controls too.
- **Interview prep is stored pre-interview material.** It is not live assistance
  and has no microphone, transcript, stream, or real-time answer surface.

## Auto-Apply Safety

The detailed enforcement model lives in [Security](security.md#approval-and-control-gates).
The user-facing guarantees are:

- live apply requires a current bound approval by default;
- system-browser apply is disabled until you explicitly enable and adopt the
  `auto-apply-browser` capability;
- dry-run has a browser-layer network/submission guard;
- submit intent is checkpointed so crashes do not cause blind retries;
- email-only applications use the same reviewed binding; and
- failed replacements never delete the last accepted materials.

::: warning Applying is irreversible
Start narrowly. Once an application or email is sent, JobCtrl cannot undo it.
:::

## Scoring Safety

Scores are applicant-side triage aids. They are not employer-side screening or
hiring decisions. Using them to rank people would require separate legal,
bias-audit, validation, notice, and human-review controls.

## LLM Spend Ceiling

`dailyBudgetUsd` defaults to `25`; `0` means unlimited. A preflight blocks the
next spendful workflow after the local daily estimate reaches the ceiling. It
does not interrupt a call already in flight and is not provider billing truth.
Current estimated spend appears on the health surface.

## Telemetry

Langfuse export is off unless configured. When enabled, prompts, completions,
workflow spans, and JSON-RPC spans may be exported. Set `LANGFUSE_DISABLE=1` to
force opt-out.

## Public Bug Reports

Use synthetic data. Never attach real profiles/resumes, databases, secrets,
OAuth tokens, generated artifacts, local paths, raw logs, or prompt traces.

From a source checkout, `corepack pnpm qa:seed` creates a disposable workspace.
The release privacy
check scans for secret/profile needles, blocked file types, and unsafe
distribution paths before publication, but it cannot protect a private file you
manually copy into a new tracked path.
