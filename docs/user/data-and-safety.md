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

Apply automation can submit applications. JobHunter separates dry-run review
from real submission:

- dry-run apply should be used first;
- submit approval is an explicit action;
- web approval facts do not submit by themselves;
- manual outcomes can be recorded without browser automation;
- failed refreshes or invalid edited drafts must not destroy current accepted
  materials.

Never run auto-apply against broad targets until you have verified profile data,
materials, field mapping, account state, and site-specific behavior.

## Scoring Safety

Scores are applicant-side triage aids. They are not employer-side candidate
screening or hiring decisions. Do not use JobHunter to rank people for hiring
without separate legal, bias-audit, validation, notice, and human-review
processes.

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
