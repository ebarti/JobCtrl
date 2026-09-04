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

Apply Review keeps its pending queue to the left at working desktop widths. The
selected application's decision, evidence, and materials then occupy one
full-width sequence rather than competing columns. When the surface becomes
narrow, the queue moves above the review and the approval/defer/decline actions
wrap below their binding explanation; no decision or audit section is removed.

## Approval And Automation Modes

Apply can rehearse browser forms and send an exact approved email application.
Use dry runs and narrow targets before employer-facing work. Persistence follows
the editing surface: every value
shown on `/discovery` is stored in SQLite, while every non-secret desired value
under `/settings/**` is stored in
[`config.json`](../api/profile-and-settings.md#config-json-field-reference).

| Setting | Where to edit it | Storage | Default | What it does |
| --- | --- | --- | --- | --- |
| `autoApply` | **Discovery → Automation settings** | SQLite `jobctrl.db` | `false` | When `true`, a running worker keeps exactly one continuous Apply workflow active for eligible prepared jobs only while `auto-apply-browser` is explicitly ready. The loop appears in Runs as the standing apply loop. It can run transport-locked rehearsals and exact-approved email sends; browser forms still require manual final submit. Turning it back off cancels that loop. |
| `applyApprovalRequired` | **Discovery → Automation settings** | SQLite `jobctrl.db` | `true` | When `true`, live claims wait for Apply Review approval and the standing loop parks unapproved jobs. Turning it off removes that claim-time gate, but does not grant browser-submit authority or bypass the owned email sender's exact recipient/attachment approval. |
| `minFitScore` | **Discovery → Automation settings** | SQLite `jobctrl.db` | `7` | Minimum score for jobs claimed by apply automation, including the standing loop. |
| `applyConcurrency` | **Settings → General** | `config.json` | `1` | Number of concurrent apply workers used by apply automation. The standing loop re-reads this setting when it polls. |
| `applyMaxBudgetUsd` | **Settings → General → Application runtime** | `config.json` | `5` | Per-application AI-agent budget cap in USD. |
| `applyTimeoutSeconds` | **Settings → General → Application runtime** | `config.json` | `900` | Time limit in seconds for one application-agent run. |

### Maximum AI budget per application {#runtime-setting-maximum-ai-budget-per-application}

This setting caps AI-agent spend for one newly started Apply job. `0` is a
zero-dollar cap, not an unlimited budget. The per-application cap works inside
the shared [daily LLM budget](configuration.md#runtime-setting-daily-llm-budget);
neither setting authorizes submission.

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
enable or disable auto-apply and authenticated LinkedIn capabilities, copy a
LinkedIn profile with explicit consent, and pair or rotate the extension token.
The same screen's live extension status is the separate prerequisite for
integrated Discovery, which uses the current Chrome profile directly and never
uses the copied Apply/LinkedIn profile described below.
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

Integrated Discovery and Enrich use the paired extension directly in the
currently running Chrome profile. Settings does not copy that profile or expose
the legacy authenticated-LinkedIn copied-profile capability. Because LinkedIn
detail recovery occurs in the user's owner-authenticated live session, JobCtrl
does not apply the anonymous crawler's `robots.txt` verdict to that request.
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
| `CAPSOLVER_API_KEY` | unset | Configure from **Settings → Credentials** on macOS or the environment elsewhere. It explicitly opts a started apply run into sending a supported widget's site key and page URL to CapSolver. Restart the relevant Python worker after a Keychain edit. The owned solver keeps keys and tokens out of the model prompt; unsupported, unconfigured, or failed solves stop the apply path. |
| `JOBCTRL_LINKEDIN_APPLY_RESOLVER` | capability-controlled | Set to `0` to disable authenticated LinkedIn posting and outbound apply-URL recovery after it has been explicitly enabled. It cannot enable the feature or grant profile-copy consent by itself. |
| `JOBCTRL_LINKEDIN_APPLY_CHROME_PROFILE` | browser default | Chrome profile name inside the resolver user-data directory. |
| `JOBCTRL_LINKEDIN_APPLY_HEADLESS` | visible Chrome | Set to `1` to run the resolver headless. |

The source checkout installs managed Playwright Chromium for PDF rendering and
standalone maintenance compatibility paths. Integrated Discovery and its
enrichment drain instead require the paired extension in the user's running
system Chrome profile; they do not launch managed Playwright. The bundled
release contains one managed Playwright Chromium headless shell, not a full
Chrome/Chromium application. System-browser adoption remains optional and is
never inferred merely because Chrome is running for the extension. Non-secret desired capability choices, including
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
