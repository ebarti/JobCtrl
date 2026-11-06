# Threat Model & Security Engineering

JobCtrl's supported security boundary is a single-user local workstation. The
accepted [Python transformation](../plans/2026-11-06-python-transformation.md)
retains that boundary while moving canonical actions to Python. **The target is
under implementation:** the controls below are requirements for the integrated
candidate, not a claim that every migrated path has passed security verification.
The [user security guide](../user/security.md) and [SECURITY.md](../../SECURITY.md)
cover user-facing guarantees and reporting.

## Repository Threat Model

### Assets and adversaries

Sensitive assets include Profile facts, evidence and attachments, resumes,
application and outreach history, SQLite data, credentials, Gmail tokens, browser
profiles and cookies, local paths, logs, and the user's reputation with
employers. Job postings, employer sites and emails, redirects, imported PDFs and
HTML, captured page text and model outputs are untrusted. Providers, browsers,
network destinations and telemetry services are separate trust boundaries.

Defend against hostile web content or pages reaching loopback, prompt injection,
unsafe file or URL handling, unauthorized external effects, stale approvals and
accidental private-data disclosure. Local data is not encrypted at rest; a
compromised operating-system account or an attacker with full local disk control
is outside this local-only boundary. Tenant-shaped fields do not constitute
hosted authentication or multi-user isolation.

### Local API and browser boundary

The Python application is intended to bind locally and check both the requested
Host and actual peer for loopback. Unsafe browser mutations require trusted local
Origin/Referer and fetch metadata or the narrowly scoped local capability
credential; an attacker cannot bypass peer/Host admission by supplying a token.
Extension routes require the capability token, including when a valid
`chrome-extension://` origin is supplied. Pairing is restricted to a first-party
local context. Token files require private permissions and no credential may
appear in logs, events or errors. Request bodies, CORS, browser origins, security
headers and file access require explicit bounds.

The work-in-progress reference implementation is
`workers/automation/src/jobctrl/app/security.py`; registration, installed
runtime and real request behavior still require integrated verification. A
loopback check is defense in depth, not authentication suitable for an
internet-facing or multi-user deployment. Do not infer a service is down from a
blocked probe without independent listener/process evidence.

### Extension and outbound destinations

Extension capture and autofill are passive until explicitly invoked; proposed
values come from current Profile sources and need user acceptance. The extension
does not own application submission. Discovery's explicitly leased browser
work must bind task, installation, execution, destination, timeout and payload
limits; cancellation and cleanup affect only task-owned tabs and resources.
Chrome owns its cookies, session and user agent: do not copy browser profiles or
accept worker-supplied browser-owned credentials and headers.

Fetching untrusted public URLs requires destination validation, rejection of
loopback/private/link-local/reserved/metadata addresses, controlled redirects,
and renewed checks for each destination. DNS checks and actual use must be
bound so a rebinding or redirect cannot reach private data. Preserve each
provider's access restrictions, source policy, pacing and budgets. Do not bypass
login, CAPTCHA, paywalls, rate limits or bot controls without explicit user
authorization. A configured provider or paired extension alone is not proof
that a live connection is ready.

### Models, files and telemetry

Model-facing job, company and contact content remains untrusted. Strict,
source-bound determinations, response validation, provenance, lane/spend
preflight and revision checks limit the consequences of unsupported claims.
Word lists, regexes or overlap cannot decide meaning or substitute for a failed
model determination. Prompt and completion content, Profile evidence, job text,
credentials and generated documents are excluded from broad events, operational
projections, diagnostics and telemetry. Treat HTML previews, document imports,
artifact paths and renderer input as untrusted: enforce size/time limits,
escaping, safe URLs and owned-path confinement.

### Severity calibration

A remote page that causes arbitrary code execution, private-data exfiltration,
remote control of the local API, or an unauthorized real application or message
is critical. Persistent UI injection, SSRF/path traversal to sensitive data, or
bypass of exact approval is high. Poisoned but still reviewable analysis or
drafts, overbroad autofill, and bounded resource exhaustion are generally
medium; impact and demonstrated boundary crossing determine severity. Local-only
tenant identifiers do not establish any hosted isolation guarantee.

## Apply-Path Containment

Applications is the owner of screening answers, exact-payload approval,
assisted execution and outcomes. Its safety obligations apply through HTTP,
CLI, direct application actions and worker retries; no alternate writer may
bypass them. Integration and synthetic product-path proof remain required.

1. **Current, specific authority.** The approved recipient, application URL,
   answers, accepted resume and any other submitted payload inputs are bound to
   their exact versions or bytes. Recheck authority at claim and immediately
   before an owned external effect. A changed source, payload, artifact or
   decision invalidates stale approval. Dry runs authorize no submission.
2. **Repeat-application protection.** Use confirmed application facts and
   canonical identity to block an exact prior application. A materially
   equivalent same-employer role requires an explicit evidence-bound,
   reasoned, one-attempt confirmation. Unconfirmed assumptions, suggestions,
   dry runs and failed pre-submit attempts are not confirmed prior applications.
3. **No model-owned final browser submit.** Untrusted employer pages and the
   model reading them never receive final submission authority. Until a trusted
   final-form manifest and one-shot mediator exist below the model, live
   browser-form completion remains manual. Browser inspection must not expose
   generic form submission, credentials, mailbox send, shell or arbitrary
   filesystem capabilities to page-controlled content.
4. **Bounded browser work.** A dry-run browser guard restricts navigation and
   side effects to the reviewed target and records its coverage; missing guard
   evidence is not a successful safe run. Redirects or other origins require
   separate authorization. Cancellation and cleanup select only the exact
   task-owned browser/process resources and preserve unrelated sessions.
5. **At-most-once owned effects.** Persist a unique, exact-payload submit intent
   immediately before an authorized owned send. A valid matching receipt can
   settle it; lost acknowledgement, process failure or uncertain provider
   response remains **needs verification**, not a safe automatic retry. A
   Temporal retry cannot create new user authority. The same principle applies
   to authorized Outreach sends.

Explicit authorization never turns a prompt-injected page, generated text or
untrusted sender into an authority for a different recipient or action. Never
submit a real application or send a real message during QA.

## Truthfulness And Integrity Gates

Profile retains authored facts, sources, confirmations and approved wording.
Requirements and Fit record model-determined meaning, support and wording
coverage with source versions. Resumes chooses only approved wording, retains
the full baseline and checks exact source and approval bindings mechanically.
A missing wording does not lower person fit. One coherence review of the
assembled resume is advisory and is recorded separately from acceptance. The
user may explicitly accept a mechanically valid, source-bound document with a
finding or timeout; the record must not claim a passed review. No unavailable
model, stale source or failed refresh may replace the last accepted artifact.
See [tailoring](../architecture/tailoring.md) and
[materials audit](../architecture/materials.md).

## Secrets And Data Hygiene

Never commit or disclose `.env` files, keys, real Profile facts, resumes,
generated materials, PDFs, screenshots containing user data, SQLite databases,
browser profiles, Gmail tokens, local paths, raw logs or traces. Use owned
synthetic workspaces and clean only task-owned temporary resources. Credentials
belong in native secret storage or explicitly inherited environment variables,
not SQLite, event payloads, snapshots or artifacts. Presence, unavailable
inspection and confirmed absence must remain distinguishable without returning
secret values. Provider failures and unexpected exceptions must be sanitized.

Browser discovery is read-only and path-free; discovering an executable does
not authorize launching, persisting or adopting it. Selection and adoption need
explicit consent, and stale identifiers fail closed. Use the release privacy
scanner and the documented release gates before release-bound changes; a
passing scanner does not authorize putting real user data in a fixture. The
published documentation site excludes repository-only plans and incident
records; review linked or generated content for accidental disclosure.

## Verification

Use the real Python application, HTTP, SQLite and durable worker with owned
synthetic state and controlled external providers. Exercise trusted and rejected
hosts/peers/origins/tokens, request bounds, stale saves, committed-only events,
source/revision changes, cancellation and restart, exact approval, intent and
ambiguous-send recovery. Verify actual browser and renderer containment where
applicable; declarations or a mocked internal API do not prove enforcement.
Record the candidate and observable results. The one-off full Profile transfer
proof is separate from the recurring E2E suite and never resets real user data.
See [local reliability QA](../local-reliability-qa.md).

## Deployment Boundary {#hosted-future-posture}

Hosted or multi-user deployment requires a separate authentication,
authorization, tenant isolation, secret custody, network and operational
security design. Local loopback protections cannot be reused as proof of those
properties.

## Reporting A Security Issue

Report vulnerabilities privately. Prefer GitHub private vulnerability reporting
when available; otherwise open a minimal public issue asking for a private
contact path, without exploit details, secrets, logs, Profile data, generated
materials or local paths. See [SECURITY.md](../../SECURITY.md).
