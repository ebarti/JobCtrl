# Applications ownership

This is the Python Applications implementation for transformation #1428 and
workstream #1436. `bootstrap.py` explicitly composes the service, feature-owned
SQLite adapter, HTTP routes and durable actions. HTTP, CLI and durable workers
call these same actions. There is no TypeScript business writer or JSON-RPC
forwarder in this owner.

`service.py` coordinates the application through the narrow ports in `ports.py`.
`application_store.py` owns the semantic atomic preparation, approval, admission,
receipt, stop and query operations; `repository.py` contains the physical SQL.
Screening and repeat application logic have their own ports and concrete stores
in `screening_ports.py`, `screening_store.py`, `repeat_ports.py` and
`repeat_store.py`. `feedback.py` uses `feedback_ports.py`; its physical schema,
SQL and committed-event adapter is `feedback_repository.py`. None of these
application services receives the full runtime or executes SQL.

`mail.py` is the external Gmail adapter. `mail_values.py` owns literal payload
grammar, `mail_support.py` explicit-path OAuth and atomic token persistence,
`mail_privacy.py` the private operation scope, and `mail_windows.py` native DACL
support. Importing these owners does not load the retired global configuration
or legacy Gmail runtime.

The retained capabilities are:

- Application-bound screening capture, source-selected drafting, user edits,
  review, a reusable reviewed library and manual-use attestations. Every
  revision and original library review remains inspectable. Sensitive Profile
  facts require exact explicit selection. Passwords are never evidence.
- Preparation of one immutable browser or email payload using public Profile,
  Jobs and accepted Resumes snapshots. Profile and resume authoring remain in
  their own owners. Email recipient, subject, body, resume bytes and field values
  are all part of the reviewed payload fingerprint.
- Read-only browser rehearsal in an owned empty browser, and source-cited model
  findings for expired pages, CAPTCHA, login, email-only routes, manual work,
  failures and uncertainty. The browser has one exact document GET, scripts
  disabled, no credentials, typing, uploads, redirects or submit capability.
  Its coverage is explicitly partial. A reviewable email-only candidate must
  become a new email payload, rehearsal and approval before it can be sent.
- Exact user approval, defer, decline and reset. Partial browser inspection
  requires explicit consent tied to the exact rehearsal. Browser execution
  returns `manual_required`; the user performs the final employer action.
- Approved email execution through a real first-party Gmail HTTP adapter with
  one transport attempt, committed intent and strict provider confirmation.
- Bounded approved batches, current eligible Fit and threshold selection,
  literal source exclusions, attempt counts, cancellation, persistent Skip,
  safe reset and restart reconciliation. Standing recurrence calls the same
  `applications.run_approved` action through the runtime schedule.
- Confirmed-opening repeat protection, source-bound model assessment of a
  different opening at the same employer with an equivalent role, and one-use
  reasoned consent. Neither an exact confirmed opening nor an existing submit
  intent can be overridden.
- Manual outcomes, bounded user-started Gmail feedback scans, private linked
  evidence, reviewed/corrected/ignored suggestions, source-request audits,
  descriptive analytics, offer milestones and follow-up counts. A model
  suggestion never becomes an application or outcome fact without review.
- The extension's existing whitelisted Profile DTO and source-bound form
  mappings. Fact IDs remain the extension's saved dot paths, and the user
  confirms proposals before filling. This port grants no submission capability.

## Canonical authority

Applications owns `applications_*` and `application_feedback_*` tables. Foreign
feature identities are references, with no sibling-private-table queries or
cross-feature business writes. Public snapshot methods receive the same SQLite
writer connection for final validation. Model calls use `Runtime.model` lane,
spend, schema and provider authority; this feature persists exact source-bound
determinations. Readers join the actual shared model receipt ID and verify its
result, operation, provider, model, prompt, lane and complete input fingerprint.
Meaning is never inferred from regexes, token overlap or lexical fallbacks.

The final email admission transaction checks the current job, Profile,
accepted resume, selected screening answers, eligible Fit, latest exact approval,
qualifying rehearsal, local stop frontier and repeat risk. It captures approved
attachment bytes, inserts one unique tenant/job intent, rechecks the attachment
before commit, then sends the pinned copy. The sender never reopens a mutable
path. The sender's pure recipient/header/body/attachment validation also runs
at preparation and before intent; a known invalid payload cannot consume an
irreversible external-action intent. Ordinary retries, resets, different run identities and worker restarts
cannot create a second intent. An absent or malformed provider receipt leaves
`needs_verification`; manual outcome recording can document what actually
happened, while the original intent remains a retry blocker.

Skip or cancellation advances `claimEpoch`. Safe reset never revives a payload
prepared before that stop: a fresh preparation and review are required. A
post-intent local stop cannot retract an admitted provider operation. Late
confirmation settles its original run and records the real outcome while
preserving the local stop. A generic permanent Job deletion cannot erase
committed submission history and manufacture permission to retry.

The browser document port validates and pins all resolved public addresses at
connection time, disables inherited proxy routing and redirects, and supplies
the bounded response to Chromium through route fulfillment. Chromium does not
resolve the posting destination. The port admits at most two outstanding DNS
reads, has a twenty-second acquisition deadline and a two-MiB document limit,
and owns duplicate socket handles so cancellation interrupts a slow body read.
An uninterruptible OS resolver retains its bounded slot; its eventual return
cannot open a socket after cancellation.

A positive Apply monetary scope requires accounting authority before provider
dispatch and is bound to the gateway's transactional quote capture. Explicit
zero disables that monetary cap; shared lane, token and process controls still
apply. Unknown usage remains unknown rather than becoming a fabricated zero.

Events contain bounded IDs, versions, state codes and presence flags. They
exclude Profile facts, screening text, email bodies, notes, generated documents,
file paths and credentials. Dedicated scoped local reads expose the private
review data; failed refreshes preserve previous accepted artifacts.

## Public entries

| Entry | Behavior |
| --- | --- |
| `GET /v1/jobs/{id}/application` | Current state, immutable preview and recorded history |
| `POST /v1/jobs/{id}/application/preparation` | `Prepare` with expected version and idempotency key |
| `POST /v1/jobs/{id}/apply-review` | `Review` of the displayed payload ID/hash and rehearsal |
| `POST /v1/jobs/{id}/application/control` | Skip, cancel, safe reset or guarded manual failure |
| `GET /v1/apply/review` | Public Jobs-composed review queue |
| `GET /v1/jobs/{id}/apply-audit` | Allow-listed run, decision and intent/receipt metadata |
| `GET /v1/applications/summary` | Real application/outcome counts and seven-day UTC follow-ups |
| Public `job_summaries(job_ids, connection=None)` | Bounded recorded lifecycle/status/source metadata for Jobs composition; absent records remain unknown |
| `GET /v1/jobs/{id}/repeat-application` | Current source-bound repeat risk and one-use consent |
| `POST /v1/jobs/{id}/repeat-application/override` | Reasoned consent for the exact current risk record |
| `GET/POST /v1/jobs/{id}/screening-answers` | Private library, history and revisioned commands |
| `GET /v1/extension/autofill/profile` | Restricted saved Profile values |
| `POST /v1/extension/autofill/mapping` | Persisted model proposals bound to captured questions |
| `GET /v1/outcomes`, `GET/POST /v1/jobs/{id}/outcomes` | Reviewed outcome reads and idempotent writes |
| `POST /v1/outcomes/suggestions/{id}/decision` | Exact review/correction/ignore receipt |
| `GET /v1/outcomes/suggestions/{id}/audit` | Saved source request and model authority; no rerun |
| `POST /v1/outcomes/gmail/scan` | Bounded user-started scan with truthful committed progress |
| `GET /v1/analytics/outcomes` | Sample-gated descriptive counts/rates/response times |

Durable entries are `applications.prepare`, `applications.rehearse`,
`applications.execute`, `applications.batch`, `applications.run_approved`,
`applications.repeat_check`, `applications.screening` and
`applications.gmail_scan`. The shared runtime owns submission, cancellation,
worker lifetime, scheduling and durable HTTP receipts. Command models are in
`domain.py` and `screening.py`; review/inspection/repeat DTOs are owned beside
their actions.

The accepted transformation removes letter generation and attachments. Parked
Applications expansion in #1128, #1032, #1029, #1195, #1040, #1034 and #1018
remains outside this implementation. Verification uses synthetic owned
workspaces and controlled external model, ATS and Gmail boundaries only.
