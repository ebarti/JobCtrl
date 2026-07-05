# Data And Safety

JobHunter is designed for local-first use because job-search data is sensitive.
This page summarizes what is stored, what can leave the machine, and which
actions require extra care.

## Local Data

Default local directory:

```text
~/.jobhunter/
```

Common files and directories:

| Path | Contents |
| --- | --- |
| `jobhunter.db` | SQLite database with profile, jobs, events, projections, settings, artifacts, review drafts, and workflow state. |
| `.env` | Provider keys and runtime settings. |
| `tailored_resumes/` | Generated resumes and related HTML/PDF outputs. |
| `cover_letters/` | Generated cover letters. |
| `logs/` | Local worker and apply logs. |
| `chrome-workers/` | Browser profiles and state for local browser tasks. |
| `apply-workers/` | Apply-run worker state. |
| `codex_home/` | Isolated SDK state used by local agent integrations when configured. |
| `backups/` | Timestamped SQLite snapshots written by `jobhunter backup`; restore steps are in the README. |
| `resume.txt`, `resume.pdf`, `resume_style.json`, `resume_template.tex` | Baseline resume inputs and style templates. |
| `gmail/` | Gmail OAuth client and token (`oauth-client.json`, `token.json`). |
| `jobhunter.db-wal`, `jobhunter.db-shm` | SQLite write-ahead sidecars; treat them as part of the database. |

The development launcher also writes PIDs and process logs under the repo's
`.dev/` directory — treat those logs as sensitive too.

Do not commit any of those files or copied variants of them.

## External Services

Depending on configuration, JobHunter can call:

- LLM providers for scoring, employer analysis, tailoring, and cover letters;
- job boards, ATS APIs, or public posting pages for discovery and enrichment;
- Gmail read-only APIs for verification-code or outcome feedback flows;
- Langfuse/OpenTelemetry endpoints for traces when explicitly enabled;
- CAPTCHA solving services when explicitly configured for apply automation.

Review configuration before running large pipelines.

## Auto-Apply Safety

Apply automation can submit real applications, so it is guarded by consent
gates: dry-run first, an explicit approval before any live submission, a
browser-layer dry-run guard, at-most-once submission, and a daily spend
ceiling. The apply agent also reads untrusted job pages, so prompt injection is
a real exposure. The full gate model, the apply agent's automation posture, and
the credential/prompt-interpolation disclosure live in [Security](security.md).

Two guarantees stay here because they are about your local artifacts:

- manual outcomes can be recorded without browser automation, and web approval
  facts do not submit by themselves;
- failed refreshes or invalid edited drafts must not destroy current accepted
  materials.

Never run auto-apply against broad targets until you have verified profile data,
materials, field mapping, account state, and site-specific behavior.

## Scoring Safety

Scores are applicant-side triage aids. They are not employer-side candidate
screening or hiring decisions. Do not use JobHunter to rank people for hiring
without separate legal, bias-audit, validation, notice, and human-review
processes.

## LLM Spend Ceiling

LLM usage is metered locally. A daily budget (`dailyBudgetUsd`, default `25`;
`0` means unlimited) gates every workflow that spends LLM tokens: a budget
preflight runs before the heavy activity and stops the workflow with a
non-retryable budget error once the estimated daily spend reaches the
ceiling. Current spend versus budget is visible on `GET /v1/health` and in
the UI health surface.

## Telemetry

Langfuse export is off unless configured. If enabled, LLM prompts and
completions are exported to the configured Langfuse instance. Set
`LANGFUSE_DISABLE=1` to opt out even when credentials are present.

## Public Bug Reports

Use synthetic data. Do not include:

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
