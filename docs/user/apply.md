---
description: "Review JobCtrl's supervised application controls: profile-bound answers, dry runs, explicit approval, browser safeguards, Gmail, and at-most-once sending."
---

<script setup lang="ts">
import ApplySafetyFlow from "../.vitepress/theme/ApplySafetyFlow.vue";
</script>

# Apply

Apply is JobCtrl's employer-facing boundary. Use this page to configure the
profile facts an application may use, review generated materials, choose the
approval and automation mode, adopt an optional system browser, and connect
Gmail for bounded verification or an explicitly approved email application.
The practical review sequence is in [Daily Workflow](normal-flows.md); the
enforcement model is in [Security](security.md#approval-and-control-gates).

For the retry and ambiguity model behind employer-facing work, read
[At-most-once Job Application Submission](../guides/at-most-once-job-application-submission.md).

::: info Command spelling
Command blocks on this page use the canonical installed spelling,
`jobctrl <command>`. Contributors running from source can use the
checkout-prefixed commands in [Local Development](../local-development.md).
:::

<ApplySafetyFlow />

## Candidate Profile Application Fields

Your active Candidate Profile is stored in the `jobctrl.db` SQLite database;
there is no second JSON-backed runtime profile. Values entered through the
Profile screen or `jobctrl init` are validated and saved to SQLite.

The Candidate Profile includes these `application_attestations` fields for
legal or screening questions that Apply automation is not allowed to infer:

- `age_18_plus`
- `background_check_consent`
- `felony_conviction`
- `previously_worked_at_employer`

Use `true` or `false` only when the answer is explicitly true or false for you.
Leave unknown answers as `null`; live apply automation fails with
`missing_profile_data:<field>` instead of guessing. `jobctrl doctor` warns
when required attestations are incomplete, and Apply Review surfaces the same
missing fields before approval when the local profile row has unknown values.

The profile also supports `application_preferences.how_heard` for common
“How did you hear about us?” questions. It is a preference, not a legal
attestation; leave it empty when there is no truthful answer.

## Materials And Resume Rendering

Use **Settings → Model selection → AI execution policy** for the
primary/fallback tailoring generators, the tailoring judge model, and its
minimum score. These non-secret desired values are stored in `config.json` and
apply to newly started workflows. Provider credentials remain on the secret
boundary described in [Configuration](configuration.md#llm-providers).

The default resume renderer is HTML/CSS printed through Playwright. Apply Review
loads the generated HTML source into a rich-text editor so text, formatting, and
hyperlink edits, comments, validation, final PDF rendering, and layout boxes stay
tied to the same material generation.

Edits autosave, and **Save draft** also lets you retry a failed save. Saving
keeps later edits in the editor; it does not render a replacement. Use **Render
replacement** to validate the saved revision. A failed render keeps the last
accepted materials and comparison available while you correct the draft or retry.
Failed comment replies retain your text. If storing review comments fails,
**Retry saving review comments** saves the existing findings again; it does not
run a new model review.

When a clean saved draft needs rendering, an authorization request prepares it
first and then reads the current application bindings. Editing, switching jobs,
or replacing the draft during preparation cancels that authorization request.
Review the current inputs and authorize again. Defer, decline and reset remain
available without rendering or starting automation.

Apply Review keeps its pending queue to the left at working desktop widths. The
selected application's decision, evidence, and materials then occupy one
full-width sequence rather than competing columns. When the surface becomes
narrow, the queue moves above the review and the approval/defer/decline actions
wrap below their binding explanation; no decision or audit section is removed.

## Skip And Safe Reset

**Skip** records a local stop for future Apply, including targeted requests,
batches and standing automation. It also blocks dry-run claims until a safe
explicit Apply reset. Approval settings do not override the stop. It preserves
accepted materials and existing attempt history.

Skip does not cancel a provider operation already in flight or prove an
application was stopped externally. Use the separate run controls for active
work, and inspect the employer site or provider history for an uncertain outcome.
If an owned email send completes after Skip, Apply Audit and the original run
history show its recorded outcome. A lost acknowledgement remains Needs verification.
Neither outcome removes the local stop or permits an automatic retry.
Recorded submit intent remains visible in Apply Audit even after Skip, later
stage changes or restart. Ordinary reset cannot clear that evidence or permit
another send. Skip also retains a prior Needs verification stop when no intent
receipt is available; changing the label cannot resolve it. **Mark Applied** remains available to record a confirmed manual
outcome.

An Apply request queued before Skip, or while Skip was active, stays fenced even
after a later reset. Start a new request after the reset to run that job. A
standing loop can pick it up on a later poll after its previous poll has ended.

An explicit Apply reset can release a local pre-submission Skip, a retryable
failure, exhaustion or cancellation when no submit intent exists. It refuses
active/queued work, Applied, Needs verification and policy-owned skip causes.
Repeated Skip preserves these underlying dispositions and their details. For
older records, retained Applied, verification and identifiable policy history
continues to block an unsafe reset. A previously skipped queued row without a
provable settlement remains blocked rather than being treated as canceled.
If an Apply owner exits after Skip but before cleanup, use
`jobctrl apply --recover-stopped` to check its recorded custody. This starts no
application and retains Skip. Installed mode requires the original native
completion proof; source mode uses its recorded owner lifetime and remains
best effort for escaped descendants. A dead process ID alone is not proof of
cleanup. Unknown or unverified custody remains blocked. Normal Apply startup
performs this check too.
Recovery after a restart and manual **Mark Applied** also preserve the existing
attempt count. Reset preserves accepted artifacts and events; the budget is retained unless
reset explicitly (or exhausted). A retryable `DRY_RUN` completion remains eligible
for another rehearsal without resetting a manual Skip.

An admitted run retains its owner across local stage changes. For a run with a
launcher custody record, reset waits for the matching cleanup settlement or
native custody retirement. A cancellation request, a stage label or a worker's
return alone cannot establish cleanup. Submit intent still blocks retry after
that settlement. Verified native retirement can restore a saved local Skip when
an old writer left its matching owner's stage marked running; it does not reset
the job. A separate safe reset remains necessary before a new request.

The CLI `apply --mark-failed <url>` records a local failure only when no active
owner, Skip, Applied outcome or unresolved submission evidence remains. Unsafe requests
exit with a refusal and preserve the current stage and history; this command
cannot establish that an external submission stopped. A safe manual failure
preserves the attempt budget and accepted materials.

## Approval And Automation Modes

For a one-off CLI batch, a finite `--limit` bounds the jobs claimed, including
jobs skipped after claim; increasing the worker count does not increase that
limit. A URL-targeted batch remains scoped to that one job. Use `--continuous`
when you deliberately want to keep polling for eligible jobs.

Distinct-job Apply runs can overlap. Each run owns its cancellation, browser,
port, dashboard and work files. Finishing or cancelling one run leaves the other
running. Every attempt receives fresh work directories, so a restart or another
worker cannot reset an earlier attempt's files. A worker whose process cleanup
cannot verify exit stops new claims and retains the prior files; other workers
already processing a job can finish and keep their accepted results.
If a batch worker crashes, the batch fails and reports worker crashes separately
from completed job counts. A cleanup refusal means exit could not be verified;
it does not establish that an owned process is still running. Installed macOS
Apply uses its own native execution scope to verify cleanup despite unrelated
process activity. When that scoped evidence is unavailable, cleanup remains
conservative and retries briefly while observations settle. Rebooting is not a
prerequisite and does not replace the required cleanup proof. If the system denies
a required process inspection or signal, Apply reports the type of failure while
retaining the affected custody; other unverified failures remain reported as
unverified.

Installed macOS Apply runs verify cleanup of their own execution before
returning, so a normal rehearsal or retry does not require stopping the app.
Recovery of an interrupted native attempt uses that execution's actual verified
completion, including detached descendants.

Source-checkout Apply waits for known children and uses best-effort cleanup for
detached descendants. Normally finished source runs and ended-owner crash
recovery can retry with fresh files and RunIds; their records explicitly say
full descendant cleanup was not verified. Actually active owners, known cleanup
failures and ambiguous submit outcomes remain protected, even after a generic
stage reset. Other jobs can proceed independently. Approval and any submit
intent stay bound to the original attempt.

Apply checks only the locally eligible candidate after repeat-application,
attempt and approval gates. When availability stays unknown, dry-run rehearsals
and the existing human-reviewed/manual Apply path remain available; approval must
still match the current materials, profile, application URL and rehearsal, and
be recorded within the preceding 15 minutes. This rule also applies when the
automation approval setting is disabled. A refused top candidate does not prevent
an eligible later candidate from being claimed.
Unattended Apply requires positive active evidence within 15 minutes. The owned
email sender rechecks the original posting and current bound review before
submit intent. Confirmed unavailability or a changed posting stops the attempt.
An availability refusal before claim consumes no Apply attempt. An availability
failure after claim remains a retryable failure and consumes its Apply attempt.
Use Job Detail's **Check availability** or **Inspect employer posting** to review
uncertainty. Checks preserve approved materials and grant no submission authority.
See [saved posting availability](enrichment-and-extraction.md#saved-posting-availability)
for cadence, offline behavior and acquisition limits.

Apply Review's **Submit gates** table shows each gate, its current state, and
the reason behind that state. It covers recorded approval, dry-run evidence,
materials, profile version, application URL, repeat-application protection,
and email details when applicable. Missing or stale evidence stays explicit;
the table does not grant approval or change what the decision buttons allow.

Apply can rehearse browser forms and send an exact approved email application.
Use dry runs and narrow targets before employer-facing work. Persistence follows
the editing surface: every value
shown on `/discovery` is stored in SQLite, while every non-secret desired value
under `/settings/**` is stored in
[`config.json`](../api/profile-and-settings.md#config-json-field-reference).

| Setting | Where to edit it | Storage | Default | What it does |
| --- | --- | --- | --- | --- |
| `autoApply` | **Discovery → Automation settings** | SQLite `jobctrl.db` | `false` | When `true`, a running worker keeps exactly one continuous Apply workflow active for eligible prepared jobs only while `auto-apply-browser` is explicitly ready. The loop appears in Runs as the standing apply loop. It sends exact-approved email applications; browser-form claims stop for manual completion and final submit. Turning it back off cancels that loop. |
| `applyApprovalRequired` | **Discovery → Automation settings** | SQLite `jobctrl.db` | `true` | When `true`, live claims wait for Apply Review approval and the standing loop parks unapproved jobs. Turning it off removes that claim-time gate, but does not grant browser-submit authority or bypass the owned email sender's exact recipient/attachment approval. |
| `minFitScore` | **Discovery → Automation settings** | SQLite `jobctrl.db` | `7` | Minimum score for jobs claimed by apply automation, including the standing loop. |
| `applyConcurrency` | **Settings → General** | `config.json` | `1` | Number of concurrent apply workers used by apply automation. The standing loop re-reads this setting when it polls. |
| `applyMaxBudgetUsd` | **Settings → General → Application runtime** | `config.json` | `5` | Per-application AI-agent budget cap in USD. |
| `applyTimeoutSeconds` | **Settings → General → Application runtime** | `config.json` | `900` | Time limit in seconds for one application-agent run. |

If you edit application runtime settings while a save is in progress, newer
values that differ from the saved response remain unsaved. Save again to apply
them, or discard them to return to the last saved values.

### Maximum AI budget per application {#runtime-setting-maximum-ai-budget-per-application}

This setting caps AI-agent spend for one newly started Apply job. `0` is a
zero-dollar cap, not an unlimited budget. The per-application cap works inside
the shared [daily LLM budget](configuration.md#runtime-setting-daily-llm-budget);
neither setting authorizes submission.
When the provider reports token counts without a per-run cost, the result omits
the per-run usage summary and the daily ledger uses its token-based estimate.
Partial token counts leave accounting unresolved as described in the shared
budget guide.

### Apply agent timeout {#runtime-setting-apply-agent-timeout}

This setting bounds one newly started application-agent run from 60 to 3,600
seconds. It is separate from Temporal activity timeouts and does not change the
standing loop's concurrency.

Combinations matter:

- `autoApply: false`, `applyApprovalRequired: true` is the default supervised
  mode: no standing loop exists, and approved browser forms still end at manual
  final submit.
- `autoApply: true`, `applyApprovalRequired: true` is a supervised standing
  loop: unapproved jobs are parked; approved email candidates can use the owned
  sender, while browser forms stop for manual completion.
- `autoApply: true`, `applyApprovalRequired: false` removes the claim-time
  approval wait. It does not create autonomous browser submit authority, and
  the owned email sender still requires an exact recipient/attachment approval.

The daily LLM ceiling and shared setting precedence remain in
[Configuration](configuration.md#llm-spend-budget). Approval is bound to the
current materials, profile, application URL, and qualifying dry-run evidence as
described in [Security](security.md#apply-approval-is-required-by-default).

Dry-run navigation is intentionally strict: the browser permits one `GET` to
the exact reviewed application URL and records that grant in the receipt.
Replays, `HEAD`, path/query changes, redirects, and later document navigation
are blocked. A multi-page application therefore needs another reviewed target
or a supervised live/manual path; dry-run does not learn navigation authority
from the page or model.

The rehearsal prompt is inspection-only. It contains the reviewed application
URL, but no applicant profile, job-description, resume, cover-letter, other
generated prose, local artifact path, or artifact-upload capability. Reviewed
materials remain local for manual completion, so a hostile page cannot reflect
their contents back into model-visible DOM.
The agent also has no generic typing, form-fill, keypress, saved-credential, or
Gmail verification-code capability. Stop at that boundary and complete any
private or write-bearing fields manually.

### Final Browser Submission Is Manual

The page-reading model never owns the final browser commit. Every model-driven
browser session is transport-locked. A live browser-form claim stops with
`trusted_final_submit_required` before the prompt is rendered, Chrome launches,
or the agent starts; direct saga and adapter calls enforce the same boundary.
Review the rehearsal and complete the employer form yourself.

This conservative boundary remains in place until JobCtrl has a trusted,
canonical final-form manifest that a human can review and a one-shot mediator
below the model can submit without giving page content generic click authority.
The separate Gmail path does not use browser click authority: JobCtrl's owned
sender rechecks its capability, records submit intent immediately before the
send, and accepts only the exact recipient and attachment approved in Apply
Review.

Immediately before owned email intent commits, the worker rereads the latest
Apply Review decision, saved profile version, posting and application URLs,
accepted materials and cover-letter binding, qualifying rehearsal, and current
email candidate. It compares those records with the delayed run's sources and
actual outgoing email in the same SQLite writer transaction as the intent.
Each email approval retains fingerprints of the complete reviewed recipient,
subject, body and attachment, plus accepted material identities and bytes.
A newer rehearsal cannot replace that approved preview. Replacing a file within
the same material generation also requires fresh review. Older approvals that
only retained recipient and attachment IDs need a new approval before email send.
Approval must identify the complete preview that was reviewed; a replacement
subject or body cannot be silently adopted when recording the decision. The
review panel captures that preview when approval is clicked. If the message,
attachment name or rehearsal identity changes during preparation, approval
stops for fresh review. An accepted resume render can update its attachment ID
only when the refreshed queue identifies that exact rendered artifact. If
approval and a defer/reset share the same recorded time, sending stays blocked
until a fresh approval at a later time. An unavailable approval read is reported
as unavailable approval authority, with review/material history preserved.
This check always runs, including when `applyApprovalRequired` is off. Defer,
reset, changed inputs, or a newly approved different candidate stop the older
run with no intent or sender call. With approval waiting enabled, a stale email
approval is refused before claim. If the email refusal happens after claim, its
reason and history are retained and settlement restores that claim's attempt
allowance. Recovery applies the same rule when settlement was interrupted. If
that refusal was recorded before a local Skip, its matching owner can restore
the attempt and park unchanged authority without releasing the Skip. An
unproven owner, changed claim or recorded submission intent is not refunded.
With approval waiting disabled, the first attempt may discover that the channel
is email. After an owned email refusal, standing polls pause that job while its
review and relevant inputs remain unchanged. A changed input or review wakes it;
an explicitly requested single-job attempt can also retry it. Other jobs continue.

The sender uses an immutable copy of the exact approved attachment bytes. A file
replacement detected while intent is being saved rolls back that intent and
requires fresh review. Replacing or removing the file after admission cannot
change the attachment in the admitted email. An independent file change after
the last check but before admission may go undetected; the admitted attachment
still uses the previously approved bytes.

Changes committed after intent cannot retract an admitted send. An interrupted
or uncertain send still requires manual verification; it is never an automatic
retry authorization.
An HTTP success alone does not mark an email application Applied. Gmail must
return a JSON object with a nonblank string message `id`. `threadId` may be
absent; if supplied, it must also be a nonblank string. Other response fields
are ignored, but the entire response must be valid JSON; `NaN` and infinities
are rejected. The internal receipt must match the recorded tenant, job, run,
intent, material generation and exact candidate fingerprint.

Missing, malformed or mismatched confirmation leaves the durable intent in
place and parks the application in nonretryable `needs_verification`. Ordinary
pickup and restart do not resend it. Review the employer site or confirmation
email before resolving the uncertainty. If a valid confirmation was already
persisted before the worker lost its acknowledgement, recovery can settle that
same operation once without sending again. Candidate previews remain available
in Apply Review; broad events and timelines carry references rather than the
email body or provider error text.

Confirmation, the submitted fact and the owned stage commit together. Losing
the acknowledgement after that commit cannot leave an accepted send without
its application history or let a delayed settlement replace a successor.
Recovery rechecks the same operation under the writer lock before parking it,
so it cannot replace an accepted concurrent confirmation with uncertainty.
Settlement resolves the current durable owner under that same lock. A caller
without a run identity cannot bypass receipt validation; a foreign run cannot
settle the current email operation.
Success notifications follow the commit; a failed settlement does not announce
an application as submitted. A duplicate execution of the same run is refused
without replacing the original operation's result or consuming its receipt.
Replaying the exact saved event is safe; a different event at the same sequence
is a conflict. Agent text, tool previews and terminal determination excerpts stay
in canonical storage rather than broad notifications. Historical email-failure
reasons and displayed needs-verification errors omit raw provider exceptions.

## Repeat-Application Protection

Before every live application claim, JobCtrl compares the target with confirmed
prior applications. The Apply Review panel shows the prior job, confirmation
fact and date, relationship reason, canonical identity evidence, evidence
fingerprint, and the related audit entries.

- **Blocked** means the prior application belongs to the same canonical job or
  an accepted duplicate identity, even when another source or apply URL
  rediscovered it.
- **Confirmation required** means the employer identity matches and the role
  title is materially equivalent after conservative normalization. Similar
  employer names do not match, and clearly distinct roles remain eligible.
- **Override ready** means the user recorded a reasoned confirmation that is
  bound to this target, one selected prior application, and the current evidence
  fingerprint. It authorizes one live claim only.
- **Override consumed** means that confirmation has already been claimed. A
  later live attempt needs a fresh confirmation against the then-current
  evidence.

Recording a confirmation requires an explicit reason. Apply Review shows a
loading state while saving it, refreshes the evidence afterward, and reports a
stale-evidence error when the relationship changed before the write completed.
It also preserves ordinary error feedback rather than enabling live submit on a
failed write. Dry runs remain available because they cannot submit and do not
establish application history.

Only canonical identity plus a confirmed `ApplicationSubmitted`, manual
`ApplicationManuallyMarked`, reviewed `applied_confirmation` outcome, or legacy
applied fact can trigger this protection. Pending Gmail suggestions, notes,
failed pre-submit attempts, submit intent alone, and dry runs do not. The worker
enforces the decision in the same SQLite claim transaction that protects
approval binding, at-most-once submit intent, and `needs_verification`; turning
off `applyApprovalRequired` does not turn off repeat protection.

## Browser Apply Automation

Use **Settings → Browser & extension** to inspect the managed core browser,
enable or disable the optional Apply browser, and pair or rotate the extension
token. Settings does not expose profile copying. Discovery and Enrich prefer
the connected extension or use guarded public HTTP/anonymous Playwright when
it is unavailable; they never use a copied profile or an adopted executable.
The separately consented legacy compatibility capability remains outside that
integrated acquisition path.
The screen may passively detect supported Chrome/Chromium installations, but
the safe list exposes only an opaque browser kind and display label—never a
local executable path. Detection does not launch, adopt, or persist a browser.
Choose a detected browser and select **Enable** to adopt it explicitly. JobCtrl
resolves the selection again at enable time and fails closed if the installation
has disappeared. **Advanced: enter executable path** is the explicit manual
fallback; an adopted path remains write-only and is not shown again.

Each Apply browser is confined to the canonical origin of the reviewed
application URL. Unexpected public redirects, popups, or ATS handoffs to a
different origin are blocked rather than silently inheriting the approval.
Review the new application destination and start a fresh run when a legitimate
provider transition requires another origin.

Origin confinement limits rehearsal navigation; it does not authorize final
browser submission. The final browser action remains manual as described above.

CAPTCHA handling during a rehearsal is also bounded. With CapSolver explicitly
configured, JobCtrl may send a supported visible hCaptcha, reCAPTCHA, or
Turnstile widget's site key and page URL through the owned solver at most once.
The provider key and returned token stay outside the model prompt. An
unsupported challenge, missing configuration, or failed solve stops the apply
path; solving a challenge never grants form-entry or final-submit authority.

Integrated Discovery and Enrich prefer the paired extension when it is connected
in the current Chrome profile. Settings does not copy that profile or expose
the legacy authenticated-LinkedIn copied-profile capability. A LinkedIn detail
request uses that live session when available and anonymous Playwright
otherwise. Neither acquisition mode consults `robots.txt`; historical blocked
rows remain retryable in either mode.
Public-destination checks, exact-origin controls, per-host pacing, run request
budgets, and audit history remain enforced. This recovery cannot fill or submit
an application; apply still requires the normal dry-run, approval, and
submission gates. Rotating the pairing token takes effect immediately and
disconnects existing extension clients; the UI never exposes the token's file
path.

| Variable | Default | What it does |
| --- | --- | --- |
| `JOBCTRL_CLAUDE_BIN` | unset | Explicit apply-agent Claude runtime override. By default apply uses a system `claude` when present, then the pinned Claude Agent SDK bundled binary. |
| `JOBCTRL_TRUSTED_JOB_SITE_CREDENTIAL_ORIGINS` | unset | Comma-separated exact HTTP(S) origins that may receive the saved job-site password, for example `https://jobs.example.com`. The current application origin must also match one entry; a job or page URL cannot enroll itself. When unset or unmatched, the credential tool is not exposed and login fails closed. Restart the worker after changing it. |
| `CAPSOLVER_API_KEY` | unset | Configure from **Settings → Credentials** or an ephemeral inherited environment. It explicitly opts a started apply run into sending a supported widget's site key and page URL to CapSolver. Restart the relevant Python worker after a credential edit. The owned solver keeps keys and tokens out of the model prompt; unsupported, unconfigured, or failed solves stop the apply path. |
| `JOBCTRL_LINKEDIN_APPLY_RESOLVER` | capability-controlled | Set to `0` to disable authenticated LinkedIn posting and outbound apply-URL recovery after it has been explicitly enabled. It cannot enable the feature or grant profile-copy consent by itself. |
| `JOBCTRL_LINKEDIN_APPLY_CHROME_PROFILE` | browser default | Chrome profile name inside the resolver user-data directory. |
| `JOBCTRL_LINKEDIN_APPLY_HEADLESS` | visible Chrome | Set to `1` to run the resolver headless. |

The source checkout installs managed Playwright Chromium for PDF rendering,
anonymous Discovery/Enrich rendering, and standalone maintenance compatibility.
A connected paired extension is preferred for integrated acquisition in the
user's running Chrome profile. The bundled release contains one managed
Playwright Chromium headless shell, not a full Chrome/Chromium application.
System-browser adoption remains optional and is never inferred from extension
pairing or anonymous acquisition. Non-secret desired capability choices, including
the explicitly adopted executable configuration, saved under
**Settings → Browser & extension** are stored in `config.json`:

```bash
jobctrl capability list
jobctrl capability enable auto-apply-browser --browser-path /path/to/Chrome
jobctrl capability disable auto-apply-browser
```

The managed optional browser-pack choice intentionally reports unavailable until
JobCtrl has a signed pack supply chain; the command does not download an
unsigned browser. The backend retains a separately consented copied-profile API
only for backward compatibility with older operator flows. Current Settings,
integrated Discovery, and Enrich do not select or invoke it.

Capability changes are live through `/v1/browser-capabilities`. The extension
pairing token remains a separate private local artifact managed through
`/v1/extension/pairing-token`, and copied browser-profile contents remain under
`$JOBCTRL_DIR/browser-profiles/`; neither is embedded in `config.json`.

## Gmail Connector And Sending Boundary

| Variable | Default | What it does |
| --- | --- | --- |
| `JOBCTRL_GMAIL_DIR` | `~/.jobctrl/gmail` | First-party Gmail connector auth directory. |
| `JOBCTRL_GMAIL_OAUTH_CLIENT_PATH` | `$JOBCTRL_GMAIL_DIR/oauth-client.json` | Google OAuth Desktop client file. |
| `JOBCTRL_GMAIL_TOKEN_PATH` | `$JOBCTRL_GMAIL_DIR/token.json` | Token written by `jobctrl gmail-auth`. |

Authenticate with:

```bash
jobctrl gmail-auth
jobctrl doctor
```

Before running the first command, enable the Gmail API in a Google Cloud
project, create an OAuth **Desktop app** client, and save its downloaded JSON as
`$JOBCTRL_GMAIL_OAUTH_CLIENT_PATH`. The command opens Google's consent flow and
writes a private local token to `$JOBCTRL_GMAIL_TOKEN_PATH`; `jobctrl doctor`
then re-checks readiness.

Authentication and refresh stage a complete token before replacing the saved
file. A write or permission failure before replacement leaves the last accepted
token intact. An interrupted process may leave a temporary token file beside
the token; it does not authorize or revoke a Google grant.
The authorization flow requests offline access and requires its own usable
refresh token. If Google omits it, authorization fails without replacing an
existing token; retry authorization. JobCtrl does not assume an older refresh
token belongs to the account selected in a new consent flow.

The connector requests `gmail.readonly` and `gmail.send`. Read-only access is
used for bounded verification-code and outcome lookups. Send access is used
only for the owned email-application path after a dry-run records the recipient
and attachment candidate and Apply Review approves that exact binding. Raw
Gmail bodies stay local and are not copied into events, telemetry, broad
projections, or logs.

To disconnect, delete the local token and revoke the OAuth client's access in
your Google Account's third-party access controls. Re-run `jobctrl gmail-auth`
to grant access again. Removing only the local token prevents JobCtrl reuse but
does not revoke Google's server-side grant.

## Outreach Follow-Ups

Outreach follow-ups are **surfaced-only reminders** — JobCtrl never sends and
has no outreach-send capability. Their posture:

- **Conservative cadence defaults.** When you schedule a follow-up without picking
  a date, JobCtrl suggests one **7 calendar days after the application was
  submitted** for the first nudge, and **14 calendar days** for a subsequent nudge
  if you have logged no reply. Every suggested date is **fully editable per
  thread** — the suggestion is only a starting point.
- **Default-off automation.** Any optional recurring follow-up reminder is
  **disabled by default** (`reminders_enabled = false`, mirroring discovery
  `scheduling_enabled`). Even when enabled it only *surfaces* due items in the
  **Follow-ups** list and badge — it never sends and never acts on your behalf.
- **A follow-up is due** purely as a read-time computation over its date and the
  clock; marking one done or dismissing it is always your explicit action.

## Reviewed Screening Answers

Job Detail and Apply Review include a [Screening Answers](screening-answers.md) library for open-ended questions. Generation, human review, copying and explicit manual-use recording are separate actions; none grants form-entry or submission authority or records an application-submitted outcome.

## Cover-Letter PDF Review

Apply Review can render the full accepted cover-letter text with bounded paper,
font, margin and spacing settings. **Preview cover-letter PDF** renders a local
snapshot; the displayed PDF and **Download displayed cover-letter PDF** use the
same file. Opening a preview or changing controls does not accept new materials.
Use **Restore accepted settings** to return to the accepted PDF. A displayed
preview with different bytes must be saved or restored before approval, even if
its settings match the accepted version.

Choose **Save cover-letter PDF** to accept that rendered snapshot explicitly.
The accepted version and local settings are shown separately. Save refuses a
stale source or accepted version; render and save again after reviewing current
materials. Edits made during a save remain local, including undoing to the
previous settings while the saved version refreshes. Rendering and failed saves
preserve prior accepted materials. If a save response is lost, reload to recover
the committed version, or retry the same preview. A replacement requires renewed
approval and dry-run evidence for the new material generation.

Approval also checks the accepted PDF's recorded byte hash against its file.
A missing, changed or unverifiable historical PDF requires a fresh preview and
explicit save. Matching source and PDF generation numbers alone do not establish
that the PDF prints the current letter. Failed checks retain the accepted record
and history; they do not adopt replacement file bytes.

Defaults are Letter, Georgia-family 11pt, 17.78mm (0.7 inch) margins, 1.6 line
spacing and 14px paragraph spacing. Controls permit A4 or Letter; Georgia, Times
or Arial font families; 9–14pt text; 8–28mm margins; 1–2 line spacing; and 0–24px
paragraph spacing. Formatting changes the full letter, including every page.
