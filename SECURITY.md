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

The local API browser boundary is defense in depth, not authentication. Requests
must target a loopback `Host` (`localhost`, `127.0.0.1`, or `[::1]`), CORS only
reflects loopback origins, and unsafe mutation requests must either carry trusted
loopback `Origin`/`Referer` metadata or no browser origin metadata at all. When a
browser sends `Sec-Fetch-Site`, unsafe mutations accept `same-origin` or `none`;
`same-site` is accepted only with trusted loopback `Origin`/`Referer` metadata,
and `cross-site` is rejected. Headerless local clients such as curl, seed
scripts, and other local automation remain allowed because local processes are
trusted in the supported local-only mode.

Browser-extension routes are the narrow exception to loopback-origin browser
CORS. They still must target a loopback `Host`, but authenticated
`/v1/extension/*` routes accept a trusted `chrome-extension://` origin only when
the request presents the local capability token generated under `~/.jobctrl/`.
The pairing token is shown from the local web Settings surface and is not a
remote-account credential. The browser extension's capture route is limited to
active-page capture after a user popup click; it queues captures only in browser
extension storage when the local stack is down. Deterministic autofill reads a
whitelisted profile DTO and fills only user-accepted values. The extension has
no application submission capability.

Setting `JOBCTRL_API_ALLOW_REMOTE_BIND=1` allows a non-loopback API bind. That
is an operator-owned risk for controlled environments only; do not expose that
mode on untrusted networks or treat it as a hosted security boundary.
