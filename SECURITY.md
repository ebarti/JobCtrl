# Security Policy

JobHunter is local-first, but the local data is sensitive: resumes, profile
facts, generated materials, job decisions, logs, browser profiles, credentials,
and local SQLite databases can all reveal private career activity.

## Reporting Vulnerabilities

Do not include vulnerability details in a public issue. Prefer GitHub private
vulnerability reporting if it is enabled for this repository. If private
reporting is not available, open a minimal public issue asking for a private
contact path and omit exploit details, secrets, logs, profile data, generated
materials, and local paths.

## Sensitive Data

Never attach or commit:

- `.env` files or API keys
- `~/.jobhunter/jobhunter.db` or any copied SQLite database
- resumes, cover letters, PDFs, screenshots with real profile data, or generated
  application materials
- browser profiles, session state, Gmail OAuth tokens, or apply-worker state
- raw logs or traces containing prompts, completions, job text, or local paths

Use synthetic fixtures or `pnpm qa:seed` for reproduction cases.

## Supported Security Posture

The current supported mode is local-only. The TypeScript API binds to loopback by
default and refuses non-loopback hosts unless explicitly configured. Hosted auth,
tenant isolation, billing, managed browsers, and production secret vaulting are
roadmap items rather than current guarantees.
