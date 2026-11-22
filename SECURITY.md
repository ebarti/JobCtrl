# Security Policy

JobCtrl is local-first, but the local data is sensitive: resumes, profile
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
- `~/.jobctrl/jobctrl.db` or any copied SQLite database
- resumes, PDFs, screenshots with real profile data, or generated
  application materials
- browser profiles, session state, Gmail OAuth tokens, or apply-worker state
- raw logs or traces containing prompts, completions, job text, or local paths

Use owned synthetic workspaces for reproduction cases.

## Supported Security Posture

JobCtrl is designed for local use. Hosted authentication, tenant isolation,
billing, managed browsers, and production secret vaulting are not current
guarantees. Consult the documentation and source for your installed release.

The in-progress Python transformation enforces a loopback peer and Host, and its
server refuses a non-loopback bind. Unsafe requests require a trusted local
browser origin or the local capability token; a headerless mutation without
that token is rejected. Trusted browser origins are restricted to configured
local ports. The capability file is private to the workspace, and extension
routes require its bearer token. These statements describe the target source;
integration and release verification are still required.

The browser extension supports user-selected capture and fill-only interactions;
it does not own final application submission. Treat credentials, pairing tokens,
and copied browser state as sensitive even in local use.
