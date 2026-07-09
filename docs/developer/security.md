# Security

JobCtrl is a local-first application, and its security model follows from that:
the trust boundary is the developer's or user's own machine, not a network
perimeter. Ordinary web and CLI API access is intentionally protected by
locality rather than identity; browser-extension routes add a scoped local
capability token without changing the loopback posture. This page explains what
enforces that boundary, how the highest-risk path (apply) is contained, which
integrity gates double as security controls, the hygiene rules that keep private
data out of the repository, and which seams change the posture if JobCtrl is
ever hosted.

**Read this if** you are changing the API surface, the apply path, or credential
and data handling, and need to know which boundary keeps private data on the
machine.

The user-facing companion is the [user Security page](../user/security.md); the
local data inventory is in [Data & Safety](../user/data-and-safety.md).

## Repository Threat Model

### Overview

JobCtrl is a local-first job-search automation system. A React/Vite UI talks to
a loopback Fastify API, the API reads SQLite projections and starts work through
JSON-RPC/Temporal, and a Python worker performs discovery, enrichment, scoring,
resume and cover-letter generation, PDF rendering, Gmail-assisted verification,
and guarded apply automation. A Chromium extension can capture the active page
and run deterministic autofill against the local API.

Primary assets are the candidate profile and resume baseline, generated resumes
and cover letters, application history, SQLite event/projection data, local
settings, LLM/API/CAPTCHA keys, Gmail OAuth tokens, browser profiles and
cookies, apply-worker state, prompt/completion traces, and the user's
reputation with employers.

The supported deployment is a single-user workstation with data under
`~/.jobctrl/`. JobCtrl is not designed as an internet-facing or multi-user
service. Security severity is therefore calibrated around remote job-board or
employer content, malicious pages visited by Playwright/Chrome, malicious
emails/PDFs/HTML captures imported by the user, local browser pages attempting
to reach loopback services, and accidental export of private local data.

### Threat Model, Trust Boundaries, And Assumptions

The core trust boundary is "a local process reading and writing local data on a
single-user machine." The adversaries JobCtrl defends against are other local
processes reaching the API without going through product gates, browser pages
reaching the API through DNS rebinding or CSRF, untrusted job postings steering
LLM or browser automation, malicious or malformed user-imported documents, and
private data accidentally leaving the machine through git, telemetry, LLM
providers, or agent/tool output.

JobCtrl does **not** defend against a compromised OS account, an attacker with
local disk access, or an operator who intentionally writes malicious values into
the local database, config, or workspace. Local data is not encrypted at rest,
so those are out of scope for the local-only product unless the issue crosses a
new boundary such as remote code execution, secret exfiltration, or real
application submission without informed approval.

Inputs fall into three groups:

- **Attacker-controlled inputs:** public job-board and ATS pages, page
  JavaScript, redirects, JSON-LD/API responses, discovered job titles,
  descriptions, URLs, apply URLs, extension-captured page text, employer emails
  scanned for verification or outcomes, user-imported PDFs and saved HTML, and
  all LLM/model outputs. These values are stored in SQLite, rendered in the UI,
  used in prompts, and sometimes become browser navigation targets.
- **Operator-controlled inputs:** local UI/API/CLI requests, profile/settings
  values, source registry entries, `~/.jobctrl/.env`, provider endpoints and
  model choices, resume template/style values, extension pairing tokens, and
  Apply Review decisions. If an attacker can modify these directly, they have
  substantial local control already.
- **Developer-controlled inputs:** docs, tests, fixtures, release scripts,
  build scripts, and packaged defaults. Findings limited to these are normally
  low risk unless the data is reachable from production runtime or the release
  path can publish private artifacts or secrets.

External services are separate trust boundaries: LLM providers, Gmail, Google
Maps, CAPTCHA providers, Langfuse/OpenTelemetry endpoints, public job boards and
ATS APIs, Temporal, the system `claude` or SDK-bundled Claude runtime, Chrome,
and any configured network proxy. Tenant IDs are currently the constant
`local`; cross-tenant isolation is roadmap/hosted-mode posture, not a current
local-mode boundary.

Locality is enforced structurally for ordinary local callers:

| Control | Mechanism | Where |
| --- | --- | --- |
| Loopback bind | The API binds `127.0.0.1` by default and refuses a non-loopback host unless `JOBCTRL_API_ALLOW_REMOTE_BIND` is set. | `apps/api/src/config.ts` |
| Host-header allowlist | Requests whose `Host` is not `127.0.0.1`, `localhost`, or `[::1]` are rejected as `forbidden_host`. This is the DNS-rebinding defense. | `apps/api/src/server.ts`, `apps/api/src/local-origin.ts` |
| Origin/Referer check | Unsafe mutation requests require a first-party local web `Origin`/`Referer`; arbitrary loopback web origins and no-token headerless clients are rejected as `cross_site_request`. | `apps/api/src/server.ts`, `apps/api/src/local-origin.ts` |
| Fetch metadata check | Unsafe browser mutations that carry `Sec-Fetch-Site` metadata must use a trusted value unless the request is a trusted extension request. | `apps/api/src/server.ts` |
| Local capability token | Authenticated `/v1/extension/*` routes require a bearer token stored under `~/.jobctrl/`; non-browser local clients can also use it for unsafe mutations when no browser origin/fetch metadata is present. The loopback Host gate still applies. | `apps/api/src/server.ts`, `apps/api/src/extension-auth.ts`, `apps/api/src/local-origin.ts` |
| Worker public-page egress guard | Contact-research public-page fetches reject loopback, private-network, link-local, reserved, unspecified, multicast, and metadata targets before fetching, disable automatic redirects, and re-run the source policy plus DNS/public-address check for each redirect target. | `workers/automation/src/jobctrl/domain/contact/source_policy.py`, `workers/automation/src/jobctrl/infrastructure/contact/research_fetcher.py` |
| Worker-readiness gate | Worker-backed action routes return `503 worker_runtime_unavailable` until a healthy worker heartbeat exists. | `apps/api/src/server.ts`, `GET /v1/health` |

::: warning The loopback assumption is load-bearing
Be honest about the limits. This posture is safe only while the API stays on
loopback; the moment it is exposed remotely, the loopback assumption breaks and
real authentication is required (see [Hosted-Future Posture](#hosted-future-posture)).
Hosted auth, tenant isolation, an encrypted secret vault, and an audit log are
roadmap items, not current guarantees — see [SECURITY.md](../../SECURITY.md) and
the SaaS section of the [backlog](../backlog.md). Local data at rest is not
encrypted.
:::

### Attack Surface, Mitigations, And Attacker Stories

**Local API, web UI, and SSE.** The Fastify API exposes powerful local routes:
profile edits, settings and credential writes, workflow starts, resume imports,
manual captures, artifact rendering/opening, Apply Review decisions, apply
controls, and the `GET /v1/events/stream` event stream. Important controls are
Zod/shared-contract validation, prepared SQLite statements, bounded DTO fields,
the loopback/Host/Origin/Referer/Sec-Fetch gates above, and the worker-readiness
gate for worker-backed actions. Because there is no local auth layer, a bypass
of locality checks or an accidental remote bind is a full local-API compromise.
React escaping, the small `MarkdownDocument` renderer, safe-link filtering in
resume audit parsing, and HTML preview CSPs reduce UI injection risk; security
reviews should still treat any externally supplied `href`, artifact path, or
HTML preview path as sensitive.

**Browser extension.** The extension is a local companion, not a hosted auth
surface. It can POST active-page captures and GET a whitelisted autofill profile
DTO only after pairing with the local capability token. It has no apply/submit
route, and deterministic autofill excludes password and resume content. Main
risks are token disclosure to a local process or malicious extension, an
overbroad autofill field whitelist, or content-script bugs that fill the wrong
field. Those risks should not be confused with remote-account authorization.

**Discovery, enrichment, and crawling.** Discovery and enrichment process public
job sources, ATS APIs, broad-board crawls, page HTML, captured API responses,
and discovered posting/apply URLs. The shared politeness gateway honors
`robots.txt` for rendered detail crawls, uses an honest User-Agent, paces
requests per host, and enforces run budgets; `python-jobspy` remains a
documented residual because its internal per-board requests cannot be
robots-gated. Contact-research public-page fetches have a private-network and
redirect egress guard; broader discovery/enrichment/browser fetches still need
review for SSRF-style navigation to loopback, RFC1918, or cloud metadata
addresses when a remotely controlled page, redirect, or discovered URL can
influence a fetch and cause captured data to be stored, rendered, sent to an
LLM, or exported to telemetry.

**LLM scoring, materials, and outreach.** Scoring, employer analysis,
interview prep, contact research, outreach drafts, resume tailoring, and
cover-letter generation combine untrusted job/contact text with sensitive
profile facts. Main impacts are privacy leakage to configured providers and
integrity attacks on scores, recommendations, generated materials, or
applicant-side outreach drafts. Controls include structured schemas,
deterministic requirement/evidence grounding, provenance rows, rendered-text
keyword coverage, never-fabricate detectors, structured judge review,
adversarial review for high-fit jobs, and fail-closed preservation of the last
accepted artifact. Prompt injection that only changes a reviewable score or
draft is usually lower severity than injection that bypasses these gates or
ships false claims to an employer.

**Apply automation.** Apply is the highest-risk path because it drives a real
browser and can submit a real application. The current apply agent runs as a
local Claude subprocess with `--no-session-persistence`, explicit
`--allowedTools`, explicit `--disallowedTools`, a filtered environment, and an
owned MCP config. The allowlist covers the safe Playwright apply subset,
read-only Gmail verification-code lookup, and owned tools such as
`type_credential`, `upload_artifact`, and optional `solve_captcha`; it does not
expose shell/file tools, raw Gmail send tools, broad mailbox access, raw
page-script evaluation, or broad permission bypass. Job-site passwords and
CAPTCHA provider keys are not placed in the model prompt: owned local tools read
them locally and fail closed. Gmail email applications are sent by JobCtrl's
owned sender only after Apply Review approval, not by an agent mailbox tool.
The detailed containment rules are below in
[Apply-Path Containment](#apply-path-containment).

**Secrets, files, and observability.** LLM provider keys use the macOS Keychain
credential store or explicit environment variables; the CapSolver key is an env
var scoped to the owned solver tool; Gmail token files are local; job-site
passwords, if saved, remain local profile data consumed by `type_credential`.
SQLite, generated artifacts, browser profiles, logs, prompts, completions, and
worker directories are sensitive. Langfuse/OTel export is opt-in and warns that
LLM prompts and completions leave the machine; enrichment spans intentionally
avoid raw posting text, resumes, cover letters, and credentials. Security
reviews should watch for secret material in logs, traces, release artifacts,
HTML previews, generated PDFs, worker stdout, and exception payloads.

**Untrusted files and generated previews.** Profile import parses user-supplied
PDFs, manual capture accepts page text/HTML, and resume review/template flows
render generated HTML/PDF previews. These paths should preserve size limits,
timeouts, path confinement under `~/.jobctrl/`, HTML escaping, CSPs, and
executable-markup checks. Bugs here are usually local DoS or file disclosure
unless attacker-controlled content can cross into code execution, API control,
or secret exfiltration.

### Severity Calibration

**Critical:** untrusted job/web content causes Claude, Playwright, or a worker
subprocess to execute arbitrary local commands; read or exfiltrate
`~/.jobctrl/`, browser cookies, Gmail content, API keys, or environment secrets;
submit real applications without a fresh bound approval; or bypass locality so a
remote attacker controls the local API. Playwright/HTTP SSRF that reads local or
cloud metadata and sends it to a DB, LLM, or telemetry provider is also
critical.

**High:** persistent XSS or unsafe URL rendering in the local UI enables API
calls, PII theft, or phishing inside the trusted local app; prompt injection
bypasses apply safeguards without shell access but materially changes submitted
answers/materials; Gmail connector flaws read broad mailbox content or send
without the owned approval path; SQL injection or artifact/path traversal
reachable from job-board content reads or writes sensitive local files.

**Medium:** prompt injection poisons scoring, ranking, employer analysis,
interview prep, outreach drafts, or resume candidates that remain reviewable;
untrusted PDF/HTML import causes local CPU/memory/storage exhaustion; an
operator-configured source or LLM endpoint performs SSRF; overbroad extension
autofill exposes more profile fields than intended; telemetry/logging exposes
PII after explicit opt-in but without clear warning or redaction.

**Low:** UI spoofing, malformed display data, broken links, non-sensitive local
DoS, or issues requiring the operator/developer to edit local config, fixtures,
database rows, or files they already control. Cross-tenant authorization
findings are low/out of scope in current local mode because there is no hosted
multi-tenant boundary, but they become high or critical once hosted auth and
tenant isolation exist.

## Apply-Path Containment

Apply is the riskiest surface: it drives a real browser and can submit a real
application, and it delegates form interaction to an autonomous agent that reads
untrusted page content. It is isolated in its own Temporal workflow with tighter
retries and layered containment. The launcher (`apply/launcher.py`), the browser
adapter (`apply/chrome.py`), and the agent adapter
(`infrastructure/apply/claude_code_cli.py`) enforce it; the full stage walkthrough
is in the [stage walkthrough](../architecture/pipeline/stages.md#apply).

- **Atomic approval claim.** The launcher opens a `BEGIN IMMEDIATE` stage-lock
  transaction and, while `approval_required` is on for a live (non-dry-run)
  submission, refuses to proceed unless the latest recorded decision for the job
  is `approve_submit`. Because the check runs inside the claim transaction, no API
  or RPC path can submit without a committed approval. Dry-run claims bypass the
  approval gate (they submit nothing).
- **At-most-once submission.** The launcher writes an `ApplySubmitIntended`
  checkpoint immediately before the agent may submit, and the claim excludes jobs
  already `running`, `succeeded`, or `needs_verification`. Combined with the
  per-job workflow ID (`apply-{tenant}-{jobKey}` + `USE_EXISTING`) and a live
  retry policy of exactly one attempt, a submit is never silently retried into a
  double application. A crash after the checkpoint parks the run as
  `needs_verification` for a human instead of blindly re-submitting; a run with no
  submit intent can be safely rewound to `pending`.
- **Browser-layer dry-run guard.** In dry-run, `chrome.py` attaches a CDP session
  that enables the `Fetch` domain and fails every non-loopback `POST`/`PUT`/`PATCH`
  request with `BlockedByClient`, plus a `Page.addScriptToEvaluateOnNewDocument`
  form-submit guard. Dry-run safety therefore does not rely on the agent choosing
  not to click submit — the transport itself refuses the write.
- **Spend ceiling as a blast-radius control.** The `check_spend_budget` preflight
  runs before the apply activity, so a runaway or injected loop cannot spend past
  the daily ceiling.
- **Prompt-injection surface.** The agent is a Claude apply-runtime subprocess
  reading untrusted third-party page text live, so prompt injection is a genuine
  exposure — the controls above bound the blast radius, they do not eliminate it.
  The subprocess runs with `--no-session-persistence`, an explicit
  `--allowedTools` surface, explicit `--disallowedTools`, and a filtered
  environment. The allowlist is limited to the safe Playwright apply subset,
  read-only Gmail verification-code lookup, and owned apply tools. Job-site
  passwords and CAPTCHA provider keys stay out of the model prompt: the local
  `type_credential` tool types configured credentials into the focused field,
  and the local `solve_captcha` tool owns provider-key use when configured.
  Gmail send is not exposed as an agent tool; email-only applications are
  recorded as review candidates and sent only by the owned email sender after a
  matching Apply Review approval.

The product-level no-bypass rule (BR-001) is the policy behind these mechanisms:
JobCtrl must never bypass CAPTCHA, paywall, login, rate-limit, or bot-control
gates without explicit user authorization.

## Truthfulness And Integrity Gates

Resume tailoring has deterministic controls that are security-adjacent because
they prevent the product from emitting false claims to an employer. A never-fabricate
detector hard-rejects any numeric, date, title, or employer token that does not
trace to recorded profile evidence; a prose skill/tool gate rejects invented
named technologies; claim grounding binds every coverage-bearing claim to shipped
rendered text; and a structured judge (plus adversarial personas on high-fit jobs)
must pass before approval. The same never-fabricate and skill/tool gates run over
the cover-letter body before it can ship. These gates fail closed — when no clean
candidate survives, the resume is not approved and the last accepted artifact is
preserved. Full detail is in [Resume Tailoring](../architecture/tailoring.md).

## Secrets And Data Hygiene

**Never commit** local secrets or generated user data: `.env` files or API keys,
`jobctrl.db` or any copied SQLite database, resumes, cover letters, PDFs,
screenshots with real profile data, browser profiles, Gmail OAuth tokens,
apply-worker state, or raw logs and traces. Use synthetic fixtures or
`pnpm qa:seed` for reproduction cases. This mirrors the rules in
[SECURITY.md](../../SECURITY.md) and `.gitignore`.

**Store credentials in a secret port.** Credentials must use the macOS Keychain
credential store or explicit environment variables, never SQLite, snapshots,
logs, traces, or artifacts (TR-013). The Keychain store
(`apps/api/src/credentials.ts`) currently holds the LLM provider keys. The
CapSolver key is an env var scoped to the owned CAPTCHA tool. A job-site login
password, if the user provides one, remains local profile data consumed by the
owned `type_credential` tool; it is not interpolated into the apply prompt.

**The release gate is enforced before release-bound changes land.**
`scripts/release_check.py` runs automatically on every push to `main` and is
available as a manual GitHub workflow for maintainer-reviewed branches. Public
pull requests do not run heavyweight CI automatically, so maintainers run the
manual workflow or local scanner before merging release-bound changes. The
scanner checks the git-tracked and untracked tree — plus any built wheel/sdist
archives — for:

- private-profile needles (real names, emails, personal domains, employer
  evidence, home paths, and private toolchain paths);
- non-placeholder secret assignments in `.env`, JSON, YAML, and TOML files;
- forbidden filenames (`.env*`, `resume.pdf`, `resume.txt`, `profile.json`,
  `token.json`) and blocked suffixes (`.db`, `.sqlite`, `.pdf`, `.log`, `.pem`,
  `.key`, `.docx`, `.har`, and database sidecars);
- browser-profile artifacts and the private `.planning/` corpus;
- a blocked distribution name combined with a tag-publish trigger.

It also scans for apply-prompt tripwires: CapSolver key interpolation,
hardcoded attestation defaults, and profile-password interpolation. The default
CI mode keeps these as compatibility warnings, while the release gate also runs
`--strict-prompt`, where any of those tripwires is a failure. Treat a passing
release check as necessary but not sufficient, and do not add real profile data
to a fixture just because the scrubber is green today.

**The docs site has a publish boundary.** The VitePress config
(`docs/.vitepress/config.ts`) excludes `docs/plans/`, `docs/incidents/`,
`docs/backlog.md`, `docs/delivered.md`, and the repo-facing `docs/README.md`
from the built site via `srcExclude`,
and rewrites any inbound link that escapes the published set (repo-root files or
unpublished internal docs) to an absolute GitHub URL so the deployed site never
ships a relative link that 404s. When adding a page, keep internal-only material
in the excluded set and link to it normally; the config handles the rewrite.

## Hosted-Future Posture

The local-only posture is a deliberate stop on the way to a hosted multi-tenant
target, and the seams that would change security are already named in
[`docs/architecture/domain-model/cloud.md`](../architecture/domain-model/cloud.md) §9 (with fitness functions in §9.4) and
the SaaS section of the [backlog](../backlog.md). The load-bearing ones:

- **API authentication.** "No auth" holds only while the API is loopback-bound.
  Any public-facing deployment triggers an Identity & Access context — Auth0 or
  Cognito issuing JWTs, validated by a gateway that injects a
  `TenantContext { tenantId, userId, roles }` into every request.
- **Tenant derivation.** Domain types already carry `TenantId`; today it is the
  constant `local`. In hosted mode the value's source changes to JWT claims — a
  mechanical change, because query keys, events, and projections are already
  tenant-scoped.
- **Secret storage.** The macOS Keychain / `.env` model gives way to a managed
  secret vault (e.g. AWS Secrets Manager) on any non-macOS or multi-tenant
  deployment, since Keychain is macOS-only and `.env` is unencrypted.
- **Browser isolation.** Local Chrome on CDP ports becomes managed browser
  sessions (e.g. Browserbase) on any cloud deployment, because running Chrome in a
  container needs elevated privileges or `--no-sandbox`. This is a day-1 cloud
  blocker, not a gradual migration.

None of these exist in local mode today; they are the next-evolution seam, and
each is gated by a concrete trigger rather than shipped speculatively.

## Reporting A Security Issue

Report vulnerabilities privately and never in a public issue with exploit
details. Prefer GitHub private vulnerability reporting when enabled; otherwise
open a minimal public issue asking for a private contact path, omitting secrets,
logs, profile data, generated materials, and local paths. The policy is
[SECURITY.md](../../SECURITY.md).
