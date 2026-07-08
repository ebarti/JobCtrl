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

## Trust Boundary And Threat Model

The threat model is "a local process reading and writing local data on a
single-user machine." The adversaries JobCtrl defends against are other
processes on the same host reaching the API, a browser page reaching the API via
DNS rebinding or CSRF, an untrusted job posting steering the apply agent, and
private data accidentally leaving the machine (committed to git or exported to
telemetry). It does **not** defend against a compromised OS account or an
attacker with local disk access — local data is stored unencrypted, so those are
out of scope by design.

For ordinary local callers, locality is enforced structurally:

| Control | Mechanism | Where |
| --- | --- | --- |
| Loopback bind | The API binds `127.0.0.1` by default and refuses to start on a non-loopback host unless `JOBCTRL_API_ALLOW_REMOTE_BIND` is set. | `apps/api/src/config.ts` |
| Host-header allowlist | Every request whose `Host` is not `127.0.0.1`, `localhost`, or `[::1]` is rejected `403 forbidden_host`. This is the DNS-rebinding defense. | `apps/api/src/server.ts`, `apps/api/src/local-origin.ts` |
| Origin/Referer check | Mutating requests (`POST`/`PUT`/`PATCH`/`DELETE`) with a non-loopback `Origin` or `Referer` are rejected `403 cross_site_request`. | `apps/api/src/server.ts` |
| Extension capability token | Authenticated `/v1/extension/*` routes require `Authorization: Bearer <token>` from the token file under `~/.jobctrl/`, accept trusted `chrome-extension://` CORS only for those routes, and still require the loopback Host gate. Capture uses `POST /v1/extension/captures`; deterministic autofill uses the sanitized `GET /v1/extension/autofill/profile`; the extension has no submit/apply route. | `apps/api/src/server.ts`, `apps/api/src/extension-auth.ts`, `apps/api/src/local-origin.ts`, `apps/api/src/profile-store.ts`, `apps/extension/` |
| Worker public-page egress guard | Contact-research public-page fetches reject loopback, private-network, link-local, reserved, unspecified, multicast, and metadata targets before fetching, disable automatic redirects, and re-run the source policy plus DNS/public-address check for each redirect target. | `workers/automation/src/jobctrl/domain/contact/source_policy.py`, `workers/automation/src/jobctrl/infrastructure/contact/research_fetcher.py` |
| Worker-readiness gate | Worker-backed action routes return `503 worker_runtime_unavailable` until a healthy worker heartbeat exists, so actions cannot dispatch into a missing or mismatched runtime. | `apps/api/src/server.ts`, `GET /v1/health` |

::: warning The loopback assumption is load-bearing
Be honest about the limits. This posture is safe only while the API stays on
loopback; the moment it is exposed remotely, the loopback assumption breaks and
real authentication is required (see [Hosted-Future Posture](#hosted-future-posture)).
Hosted auth, tenant isolation, an encrypted secret vault, and an audit log are
roadmap items, not current guarantees — see [SECURITY.md](../../SECURITY.md) and
the SaaS section of the [backlog](../backlog.md). Local data at rest is not
encrypted.
:::

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
