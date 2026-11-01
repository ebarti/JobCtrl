---
description: "Understand where JobCtrl stores profiles, jobs, resumes, browser state, and telemetry, and when a user-triggered feature contacts an external service."
---

<script setup lang="ts">
import DataBoundaryMap from "../.vitepress/theme/DataBoundaryMap.vue";
</script>

# Data, Privacy & Safety

JobCtrl stores your working data on your computer. Network access happens only
when a feature you start—or a schedule you explicitly enable—needs a configured
external service.

This page owns the data inventory and responsible-use boundaries. For the
controls that enforce risky actions, read [Security](security.md). Feature
settings live in [Discovery](discovery.md) and [Apply](apply.md); shared
providers, precedence, and spend controls live in
[Configuration](configuration.md).
For a plain-language overview, read
[Local-first Job Search Automation](../guides/local-first-job-search-automation.md).

## Privacy Quick Answer

| Question | Answer |
| --- | --- |
| Do I need a hosted backend or a JobCtrl account? | ✕ **No.** App, API, worker, database, and files run locally. |
| Are the database and generated files stored locally? | ✓ **Yes, by default.** They live under `JOBCTRL_DIR` (normally `~/.jobctrl/`). |
| Does JobCtrl call AI models or other providers automatically? | ◐ **Only when you use a configured feature.** Generation and opted-in research call providers during runs you start or schedules you explicitly enable. |
| Does Discovery make network requests? | ✓ **Yes—that is how it searches configured job sources and, for AI-assisted steps, communicates with the model providers you selected.** Requests occur during runs you start or schedules you explicitly enable. |
| Is product telemetry enabled by default? | ✕ **No.** Langfuse requires configuration; `LANGFUSE_DISABLE=1` overrides it. |
| Does this documentation site use analytics? | ◐ **Only after you accept.** The optional Google Analytics tag stays unloaded until you choose **Accept analytics**; declining keeps the documentation fully available. |
| Does Discovery use my browser profile? | ◐ **When the selected paired extension is connected.** Discovery and Enrich prefer its live profile for bounded HTTP/API tasks and temporary inactive tabs. Without it, they use guarded public HTTP or anonymous managed Playwright. They never copy or separately launch your profile, and a fetch failure does not change transport. |
| Does application-submission browser automation run continuously? | ✕ **No.** It starts only through apply/dry-run work you initiate or a standing loop you explicitly enable. |
| Does JobCtrl submit applications or send employer-facing email by default? | ✕ **No.** Browser submission and Gmail application sending are explicit guarded actions. |
| Does browsing Interviews call a model? | ✕ **No.** The installed public catalog is local. Job-specific generation is a separate explicit provider-backed action. |
| Does Outreach send messages automatically? | ✕ **No.** Drafts end at copy/export; send logs are user attestations. |
| Does Plate PDF export upload or register my edited resume? | ✕ **No.** The browser renders the currently visible Plate document into a download; it does not call a generation provider, save the edits, or register a JobCtrl artifact. |

Local-first does not mean offline. Discovery fetches sources, generation calls
models, and live apply contacts an employer only when you use those features.

<DataBoundaryMap />

## Documentation Site Analytics

The documentation at `https://jobctrl.dev` uses optional Google Analytics 4
measurement only after consent. On a first visit, the cookie banner offers
**Decline analytics** and **Accept analytics** without blocking the guide.
Before acceptance, the site does not load or contact Google Analytics.

The consent choice is stored in browser local storage under the versioned key
`jobctrl-docs-analytics-consent-v1`. The footer's **Cookie settings** control
reopens the choice at any time. Declining or withdrawing consent stops new page
views, removes the Google tag from the page, and attempts to delete the
documentation site's `_ga`, `_gid`, and `_gat` cookies. Withdrawing reloads the
current documentation page so the previously loaded third-party runtime is no
longer present. It cannot delete measurement data Google already received.

After acceptance, the site loads Google tag `G-KB495KG6MS`. Page views contain
the documentation path and page title, without URL query strings or fragments.
Google may also receive the referrer, browser/device details, interaction data,
and an IP address used for geolocation before it is discarded. JobCtrl disables
Google Signals plus advertising and personalization signals, and configures
host-only Google Analytics cookies that are not sent to `demo.jobctrl.dev` and
expire within six months. A denial or withdrawal in one documentation tab
reloads other open documentation tabs so none keep a stale consented tag.
Google's handling of that data is described in
[Safeguarding your data](https://support.google.com/analytics/answer/6004245).

The data controller for this documentation measurement is Eloi Barti, acting as
an individual. For privacy questions, contact
me[at]eloibarti.com (replace [at] with @). This hosted documentation
measurement is separate from JobCtrl's local product telemetry and from the
public demo measurement described below.

## Public Demo

The hosted synthetic demo is separate from the local product described above.
It can only be used after accepting analytics cookies for JobCtrl's bounded
first-party demo measurement and Google Analytics. Declining returns to
`https://jobctrl.dev`; opening the demo again shows the choice again. The demo
does not initialize its browser-local workspace or load the Google tag until
the consent service confirms acceptance. The `v2` consent contract replaces the
earlier first-party-only choice, so existing visitors are asked again once.

The data controller for the public demo is Eloi Barti, acting as an individual.
For privacy questions, contact me[at]eloibarti.com (replace [at] with @).

After acceptance, Cloudflare sets a versioned consent cookie plus random
HttpOnly visitor and session identifiers. JobCtrl's persistent cookies expire
within six months, the session cookie at the end of the browser session, and raw
demo events and non-linkable operational counters expire within 90 days. Those
first-party events use closed route/action/result categories: they exclude
names, contact details, profile or resume text, job/company content, URLs,
searches, comments, local paths, raw errors, and demo entity/workspace
identifiers. IP addresses may be used transiently by Cloudflare rate limiting
but are not written to D1 or application logs.

The accepted page also loads Google tag `G-6MJGD17JN0`. Google Analytics may set
`_ga` cookies scoped to the demo host for up to six months and receive standard
web-measurement data such as page location, referrer, browser/device details,
interaction data, and an IP address used for geolocation before it is discarded.
JobCtrl disables Google Signals plus advertising and personalization signals in
the tag configuration. Google's handling of that data is described in
[Safeguarding your data](https://support.google.com/analytics/answer/6004245).

The demo contains synthetic data. Do not enter personal data, credentials, or
secrets. Post-accept withdrawal and immediate visitor-event deletion are not
yet available in this MVP; retained data and cookies expire on the schedules
above. The consent screen links to this disclosure before entry.

The [demo access, consent withdrawal, and visitor erasure proposal](../plans/2026-09-22-demo-access-consent-withdrawal-proposal.md)
is a future design for [#885](https://github.com/ebarti/JobCtrl/issues/885).
It is **PROPOSED**, awaits owner decisions, and does not change the current
consent gate, retention, or deletion behavior described above.

After entry, the compact **Demo guide** links to seeded scoring evidence,
tailored-material review, Apply Review/dry-run, and run history. Every shortcut
and action is simulated; it does not contact employers, send messages, or make
external changes. **Reset synthetic demo data** asks for confirmation, then
replaces the browser-local workspace with the original examples.
Stage retry and rescoring are unavailable in the demo, including for retained
synthetic histories that recorded a retryable failure.
When a deployment changes the versioned synthetic seed, the next demo load
performs the same replacement automatically: it rotates the workspace identity,
clears pending simulated actions, and deletes generated demo blobs. This seed
refresh does not change the separate consent cookie or telemetry-retention
schedule.

## Local Data

Default workspace:

```text
~/.jobctrl/
```

Unless a row says otherwise, every path below is relative to JOBCTRL_DIR
(normally `~/.jobctrl/`).

| Path | Contents |
| --- | --- |
| `jobctrl.db` plus `-wal` / `-shm` | Profile, jobs, discovery settings, events, projections, artifact metadata, import receipt bindings, review drafts, contacts, private offer terms/decisions and sources, and workflows. Treat all three files as one database. |
| `temporal.db` plus `-wal` / `-shm` | Shared Temporal history for new workspaces; earlier source workspaces may retain `temporal/temporal.db`. Treat the history and `jobctrl.db` as one pair. |
| `config.json` | Non-secret Settings values: general controls, provider configuration metadata, preferred model IDs, compensation source policy, and browser-adoption metadata. No API keys or feed contents. |
| `.env` | Legacy/plaintext provider credentials used by remaining compatibility paths. Not encrypted at rest. |
| `codex_home/` | Stable JobCtrl-owned Codex CLI state. `auth.json` is outside the prompt-readable `workspace/` subtree. |
| `claude_home/`, `provider-packs/`, `provider-runtime/` | Isolated or separately acquired provider runtime state. |
| `tailored_resumes/`, `cover_letters/` | Generated text, HTML, and PDF artifacts. |
| `profile-imports/` | Uploaded import PDFs retained for retry. The corresponding source-attempt bindings, which contain the digest and observed style but no PDF bytes, are in `jobctrl.db`. |
| `logs/`, `apply-workers/`, `chrome-workers/` | Logs and local browser/apply state, including CAPTCHA usage metadata when applicable. |
| `browser-profiles/` | Consented copied profiles retained for separate compatibility capabilities. Integrated `DiscoverWorkflow` never reads or launches them. Non-secret adoption metadata lives in `config.json`. |
| `extension-capability-token`, `extension-discovery-installation-id` | Private local browser-extension pairing secret and the extension installation selected for Discovery. Discovery bridge task bodies and results are memory-only and are not stored beside them. |
| `backups/` | Database snapshots: `pair-<id>/` from installed operations; `source-pair-<id>/` from automatic source upgrades; application-only `jobctrl-<timestamp>.db` snapshots; and job-data purge recovery bundles. See [Back Up And Restore](#back-up-and-restore). |
| `gmail/` | Gmail OAuth client and token files. |
| Baseline/legacy resume files | `resume.txt`, `resume.pdf`, and older local style/template files. |

The resume-import wizard also keeps its selected PDF and filename in the web
app's browser-local storage, outside `JOBCTRL_DIR`. Cancel keeps that selection;
earlier-version import data remains separately stored even after current cleanup.
The extracted review draft is also saved in browser-local storage until it is
accepted or rejected. New drafts contain the reviewable fields, the saved values needed
to compare personal details, the profile version, and extraction receipt IDs and
warnings; they do not contain the complete saved profile or resume text preview.
Older retained review drafts may still contain the complete saved profile,
including its password field, and the extraction text preview. They are preserved
on reload, and a complete copy is retained within the draft if it is rebased.
After acceptance or rejection, Profile exposes the preserved legacy review as
JSON for inspection and copying; it stays in browser storage until site data is
cleared.
The completed request remains in app memory until reload. Removal and failure
recovery are described in [Candidate Profile](candidate-profile.md#review-an-imported-resume).

PDFs created with a Plate editor's **Export PDF** control are ordinary browser
downloads, so their destination is the download location selected by the
browser or operating system rather than `JOBCTRL_DIR`. JobCtrl does not register
that copy as a material artifact or use it to replace an accepted generation.

The development launcher writes PIDs and logs under the checkout's `.dev/`
directory; treat those logs as sensitive too.

### Back Up And Restore

Legacy achievement recovery uses only a trustworthy pre-cutover native paired
backup with `pair.json` and both database files. Independently captured app,
Temporal and file copies do not establish a stopped pair. The local
[legacy confirmation review](candidate-profile.md#review-legacy-confirmations)
command validates backup bytes, inventories original/current evidence for
explicit review and never restores databases or overwrites newer edits. If a
trustworthy pair is unavailable, record that uncertainty explicitly and review
current cells; no record is automatically reconfirmed.


```bash
jobctrl backup
```

The installed command snapshots `jobctrl.db` and `temporal.db` together into a
new `backups/pair-<id>/` directory. If JobCtrl is running, it stops for the
snapshot and starts again afterward. If a source development fleet is running,
stop it first; the installed backup command does not replace it with the
installed app. `--output` takes an absolute directory.
The two files are one restore unit: never restore just one of them. The
launcher has no restore command for these pairs; updates and rollbacks write and
restore their own, as described in
[Update, Roll Back, Or Remove JobCtrl](getting-started.md#update-roll-back-or-remove-jobctrl).

When a release promotion performs automatic release cleanup, JobCtrl keeps
releases referenced by paired backups in the current workspace `backups/` and
other workspaces recorded by the runtime, including a custom `JOBCTRL_DIR`.
A source workspace is included when its checkout and runtime ownership can be
verified; otherwise cleanup stops and preserves releases. Cleanup also preserves
releases if an independent Apply run lacks verified completion, even after its
launcher exits. It does not stop the run or prevent an ordinary restart.
Paired backup metadata in differently named folders is still considered;
unrelated folders without `pair.json` are left alone. If workspace ownership,
pair metadata, or the release store's directory identity
cannot be verified before cleanup, cleanup stops before deleting releases. A
release is eligible for cleanup only if its sequence and identity are recorded
in channel state and its signed payload and expected metadata can be verified;
releases without that recorded history, modified payload files, and extra files
and directories are preserved. Generated receipt and policy files are not
independently signed, so a valid edit to those files cannot always be
distinguished from the original metadata. A release claimed for cleanup that
cannot be safely returned is
preserved under a `.retention-*` directory for inspection. An interruption during
cleanup may leave a partially removed owned release there. An actively
concurrent writer with access inside that claimed directory can race the last
check before an individual file is removed. Writers that change backup
authorities outside JobCtrl's runtime transition lock can also race cleanup's
reference checks. The message identifies when the new release is already active.
Backups placed elsewhere with `--output` are outside this automatic discovery.
Retention alone does not make a rollback eligible: the release must also pass
its safety policy and the paired files must pass verification.

In a source checkout, `uv --project workers/automation run jobctrl backup`
writes one consistent copy of `jobctrl.db` to `backups/jobctrl-<timestamp>.db`
with SQLite `VACUUM INTO`. It is safe while the app runs and never deletes
anything; `--output` takes a file or directory. This is an application-database
snapshot, not a stopped and verified application/Temporal backup pair. It is
not sufficient to restore a workspace with workflow history. Preserve the live
databases and their WAL/SHM companions; do not delete companions or replace one
database in isolation. The source checkout does not currently offer a paired
restore command. See [Local Development](../local-development.md#schema-migrations-and-source-updates)
for automatic source upgrades and recovery limitations.

After restoring or replacing a database, restart JobCtrl (or rerun
`corepack pnpm dev` in a source checkout) and reload any open JobCtrl browser
tabs to create fresh event subscriptions. API callers that supplied an explicit
`?since` cursor must discard it and start a fresh subscription too.

Never hand-import individual tables or reset projection watermarks as a
substitute for a verified workspace recovery.

#### Interrupted first database creation

If startup reports an unresolved database publication, do not delete or open
`jobctrl.db` or its `-wal`, `-shm`, or `-journal` companions while JobCtrl is
running. Stop every JobCtrl process and independently confirm that no process
has the workspace database open. Keep a private copy of the database, all
companions, and the `.jobctrl-init-*` staging directories before changing any
of them. The workspace defaults to `~/.jobctrl/`; use the configured
`JOBCTRL_DIR` instead when it is set.

If no companions exist, identify the retained staging directory whose regular
`candidate.db` is the **same device and inode** as the regular `jobctrl.db`.
Only when that directory contains exactly that one file, and the database has
been independently verified as a readable exact-schema database, removing the
staged hard link and its now-empty directory permits startup to retry. Do not
remove `jobctrl.db`. If any companion exists, the files are not the same inode,
the directory has other contents, or process ownership or database integrity is
uncertain, preserve everything and seek help or use a verified backup. Native
backups restore the JobCtrl and Temporal databases as a pair.

#### Runtime cleanup failures

A native paired backup, update or rollback must pass the complete process-cleanup
gate. `jobctrl stop` requests clean shutdown, kills verified timed-out leftovers,
and waits for their exit. Successful cleanup permits normal restart. A missing
or unfamiliar ownership record is a failure, including legacy records that
cannot identify detached children; JobCtrl preserves the registry and live data
instead of claiming they are stopped. Inspect the reported process/permission
problem and preserve the reported evidence. For a legacy runtime without
complete ownership records, there is currently no documented self-service
recovery; seek support. Restarting the computer alone does not clear this
refusal. Do not delete ownership metadata or restore an older pair to bypass it.

### Credentials Outside The Workspace

The macOS credential panel guides Codex, Claude, and Google setup. Codex uses
the stable, separate `$JOBCTRL_DIR/codex_home`. Codex-backed work requires
an authenticated Codex CLI first. If its `auth.json` is absent,
setup or generation may copy valid authentication once from the effective
normal Codex CLI home. JobCtrl never overwrites existing isolated auth or
changes the normal home. Only `auth.json` is copied; personal Codex settings,
instructions, skills, chats and logs are not imported. JobCtrl does not save
Codex generation chats. Concurrent provider clients share temporary SQLite
metadata and SQLite logs instead of importing retained history into a database
for every client. The last closed client removes that store; each client removes
its own temporary text logs. A later startup can reclaim a recognized abandoned
store after acquiring its owner lock. Active stores and unfamiliar paths are
preserved. Existing provider files from earlier versions are preserved. The auth file remains outside
`codex_home/workspace/`, the only JobCtrl Codex subtree available to
prompt-driven reads.
Anthropic and Gemini API keys use the native OS credential store; cloud
activation flags and non-secret identifiers belong in `config.json`. AWS,
Google, and Azure credential files remain in their vendor stores. After
environment-file loading, Python loads native credentials at startup only when
the corresponding environment value is missing or empty. Any non-empty
inherited value wins. Restart JobCtrl after saving or removing a value.

The adapters use macOS Keychain, Windows Credential Manager, or Linux Secret
Service. The panel returns status, never stored values. Unknown
(`inspection_failed`) means the store could not be inspected, not that a
credential is absent. Unlock or restore access to the native store and retry.
See [Configuration](configuration.md) for legacy plaintext migration and its
scope; migration does not erase old backups or vendor-managed auth files.

::: tip Protected by default
The normal workspace is outside the repository. `.gitignore` and the release
privacy scan add safeguards. From a source checkout, use `corepack pnpm
qa:seed` for anything you intend to share.
:::

### Contacts And Outreach

Contact values and notes stay in canonical local tables. Events and broad
projections carry only IDs, kinds, counts, timestamps, and provenance metadata.

Contact research is supervised:

1. you provide or opt into a permitted source;
2. JobCtrl records the source attempt and proposes candidates;
3. you confirm a candidate before it becomes a contact.

Draft bodies, gate results, and claim provenance are stored locally. When you
request a generated or edited outreach draft, its relevant profile/contact
facts and actual text go to the configured provider for drafting and review.
Offer communication additionally sends the confirmed offer terms, source
quotations, decision attestation and existing compensation evidence. Recording
or reading terms/decisions alone makes no provider request. Private offer
ledger payloads stay out of general event-stream and activity/audit responses.
An approved draft can be copied/exported; JobCtrl has no outreach send transport. Logging a send
records something you did. Follow-ups are reminders and never act automatically.

### Interview Guidance, Preparation, And Notes

The installed question catalog contains public editorial research and synthetic
examples. Its source ledger records whether guidance comes directly from an
interview source, extrapolates leadership practice, or is editorial synthesis,
and how much of each source was read. Attribution does not imply author
endorsement or prove any personal claim. The catalog and its criteria remain a
research draft; they do not establish hiring outcomes or validated grading.

Browsing the library needs no job, database, live worker, or provider call.
Opening an external source link uses the browser's normal network access.
Explicit job preparation sends only the selected cards and bounded relevant
profile/job context to the configured model under the existing provider and
spend controls. It does not generate a personalized answer for every card.

Accepted prep, its retained input excerpts, generation history, and revisioned
per-question notes are private local job data. Notes are user edits and new
recollections remain unverified statements; saving or generating preparation
does not promote them into Profile, change fit scores or Discovery intent,
replace approved resumes, or authorize Apply. Question, job, generation, and
revision IDs may enter events; answer, note, profile, and excerpt text may not.
The local retention and job-deletion boundary applies to these records. Keep
notes and prep out of screenshots, public issues, PRs, and shared logs.

The compensation question C07 asks for the employer's budgeted range first.
Public negotiation guidance is separate from your private compensation
preferences. It must not disclose an inferred minimum or treat a deliberate
user-chosen exception as a competency failure. The retired C08 ID remains
reserved: logistics and authorization are your declared checklist facts.

Reusable preparation without a job, typed rehearsal, calibrated assessment,
and live interview assistance are not shipped by this integration. See
[Interview preparation](materials-and-tailoring.md#interview-preparation).

## External Services

| Service | When used | Data involved |
| --- | --- | --- |
| LLM providers | Scoring, employer analysis, materials, contact extraction, stored interview prep, offer communication drafts, opted-in Required-bullet coaching | Posting text, relevant profile evidence, generated text, or opted-in fetched page text. Offer communication includes confirmed actual terms and quotations, the decision attestation and recorded compensation evidence; saving or reading an offer does not call a provider. Required-bullet coaching sends selected saved Required bullets, their role/company context and matching achievement evidence to your configured provider. Candidate interpretation and target-role suggestions send minimized saved profile sources to the configured Profile provider after spend preflight. Every suggestion cites source IDs and verbatim spans and needs your confirmation; provider or budget failure reports unavailable without a lexical substitute. |
| Job boards, ATS APIs, posting pages | Discovery and Enrich prefer the connected paired extension; otherwise acquisition uses guarded public HTTP or anonymous Playwright | Both modes send search terms, URLs, and page/API requests. Connected Chrome may also send cookies or session state belonging to that site; its cookie values are never copied into worker tasks or results, and its user-agent string is returned as transport metadata. Anonymous acquisition uses no personal Chrome profile or ambient netrc credentials. |
| Apply model and browser | Apply/dry-run work you start, or a standing loop you enable | The reviewed application URL and the page content observed during the transport-locked inspection. Profile fields, job-description prose, resume and cover-letter text, local artifact paths, and upload authority are excluded; see [Apply](apply.md#approval-and-automation-modes). |
| Salary data sources | At the end of a Discover run, only for benchmark slices that are missing or past their seven-day freshness window; Levels.fyi or Glassdoor only when their Settings policy permits | Requests for public benchmark data from Euro Top Tech, ECB exchange rates when a currency conversion is needed, and Eurostat price levels when a slice has no direct benchmark. Levels.fyi public-page URLs name the role and location being benchmarked. |
| Gmail | Authenticated verification, bounded outcome feedback, or an approved email application | Scoped queries/evidence or the exact approved recipient/attachment. |
| Google Maps | Profile location autocomplete with a configured key | Address text typed into the location field. |
| CAPTCHA provider | Supported widget during an apply run you explicitly start or a standing loop you enable, with a configured solver | Site key and page URL through the owned local tool. |
| Langfuse/OpenTelemetry | Explicitly configured telemetry | Metadata-only LLM, workflow, and JSON-RPC spans: provider/model, operation/stage, outcome, token counts, and safe sizes. |

When using the connected paired extension, Discovery and Enrich capture HTML
and text from your current Chrome session. If you are signed in, those snapshots
can include account-personalized content beyond the posting, such as greetings
or job-match panels. Anonymous acquisition captures public HTTP responses or
pages rendered in a managed browser without adopting your personal Chrome
profile. Anonymous JobStreaming sessions do not read `NETRC` or `~/.netrc`;
provider-supplied protocol headers and cookies still work. Configured proxies
that would route an anonymous provider request are rejected, including on
redirects, because their destination DNS cannot be pinned safely.

In either mode the worker processes the acquired content. Extracted posting
text can be persisted locally, and page HTML or posting text can be sent to
configured LLM providers for extraction and later pipeline stages. Keeping
broker tasks in memory does not prevent this downstream persistence or LLM
processing.

Review [Security → What Leaves Your Machine](security.md#what-leaves-your-machine)
before enabling a provider.

## Responsible Use Boundaries

- **Employer actions are irreversible.** Rehearse with dry-run, review current
  materials and field mappings, complete browser final submission manually, and
  keep `applyApprovalRequired` enabled for live claims.
- **Email applications are live submissions.** They require a recorded
  recipient/attachment candidate and matching Apply Review approval.
- **Source access has terms.** Enable only job boards, feeds, and public pages
  you are allowed to query. JobCtrl does not authorize access for you.
- **CAPTCHA and login flows fail closed.** Unsupported challenges, identity or
  biometric checks, payment/bank prompts, and missing credentials require human
  handling.
- **The API is loopback software.** Binding it beyond `127.0.0.1` or tunneling
  it can expose private profile, job, artifact, and credential-adjacent data.
- **LLM spend is real.** `dailyBudgetUsd` limits new JobCtrl workflows based on
  a local estimate; keep provider-side billing controls too.
- **Interview prep is stored pre-interview material.** It is not live assistance
  and has no microphone, transcript, stream, or real-time answer surface.

## Auto-Apply Safety

The detailed enforcement model lives in [Security](security.md#approval-and-control-gates).
The user-facing guarantees are:

- live claims require a current bound approval by default;
- system-browser apply is disabled until you explicitly enable and adopt the
  `auto-apply-browser` capability;
- Settings may detect a supported browser for display, but detection is
  read-only and exposes only an ID/label pair. JobCtrl does not launch, copy,
  persist, or adopt it until you explicitly select and enable that capability;
- dry-run has a browser-layer network/submission guard;
- model-driven browser sessions are transport-locked and final browser submit
  remains manual;
- the owned email sender checkpoints submit intent immediately before sending,
  so ambiguous crashes do not cause blind retries;
- email-only applications require the same reviewed recipient/attachment
  binding; and
- failed replacements never delete the last accepted materials.

::: warning Applying is irreversible
Start narrowly. Once an application or email is sent, JobCtrl cannot undo it.
:::

## Scoring Safety

Scores are applicant-side triage aids. They are not employer-side screening or
hiring decisions. Using them to rank people would require separate legal,
bias-audit, validation, notice, and human-review controls.

## LLM Spend Ceiling

`dailyBudgetUsd` defaults to `25`; `0` means unlimited. A preflight blocks the
next spendful workflow after the local daily estimate reaches the ceiling. It
does not interrupt a call already in flight and is not provider billing truth.
Current estimated spend appears on the health surface.

## Telemetry

Langfuse export is off unless configured. Its default is metadata-only LLM,
workflow and JSON-RPC spans. Set `LANGFUSE_DISABLE=1` to force opt-out.

For deliberate debugging, `JOBCTRL_TRACE_CONTENT=1` additionally captures LLM
messages and returned completions on their generation spans. When supplied by the
adapter, the capture also includes the response schema and exact runtime prompt
and instructions. This sends job, profile and generated-material text contained
in those inputs/outputs to your configured Langfuse destination. Use a destination
you intend to receive that private data; unset the flag to resume metadata-only
capture. Existing captured bodies remain in that destination until removed there.
Arbitrary request parameters, authentication/configuration objects, runtime paths,
logs, databases and exception messages are not added by this opt-in.

## Public Bug Reports

Use synthetic data. Never attach real profiles/resumes, databases, secrets,
OAuth tokens, generated artifacts, local paths, raw logs, or prompt traces.

From a source checkout, `corepack pnpm qa:seed` creates a disposable workspace.
The release privacy
check scans for secret/profile needles, blocked file types, and unsafe
distribution paths before publication, but it cannot protect a private file you
manually copy into a new tracked path.

Reviewed locale revisions retain the original accepted source snapshot, selected
canonical facts, translator/verifier determinations and review history locally.
Generation sends that minimized source context to the configured tailoring model
under its spend policy. Locale acceptance never submits an application. Accepted
TXT/HTML/PDF/DOCX files remain registered local artifacts; failed refreshes preserve
prior bytes. See [Reviewed Locale Variants](locale-variants.md).

## Private Screening History

[Screening answers](screening-answers.md), selected source facts and manual-use text are private local SQLite history. Only deliberate selected facts and exact saved question/posting context go to the configured Apply model lane. General activity and SSE carry safe references. Copying and manual-use attestation grant no form-entry or submission authority.

Optional [company briefings](company-briefings.md) fetch only explicitly selected anonymous public pages and send bounded public text plus the reviewed company identity to the enrichment model. They send no profile, mail, resume or search query. The local database retains source snapshots, model receipts and accepted/failure history; shared company history survives removal of its linked jobs.

## Selected-job comparison data

Reviewing a selected-job cohort is local and makes no model call. Explicit
comparison sends only the selected saved posting descriptions, their job
identifiers/title/employer context, and usable confirmed achievement excerpts
to your configured provider in the Profile lane. Personal contact fields,
unconfirmed evidence, declared skill lists, aspirations and milestone activity
are not comparison evidence inputs. No external learning-resource research runs.

Cohort revisions and chosen milestones retain private source snapshots,
comparison provenance and user completion statements in local SQLite. Historical
origins remain after Profile/cohort changes and job deletion. The job-data purge
preserves them and reports their retained `career_learning_records` count.
They are not sent in general SSE events or converted into Profile skills,
readiness, fit scores, application approvals or submission authority.

## Retained Source Proposal History

The opt-in `source-proposals from-history` command checks source hostnames through
DNS; it sends no saved posting content to a model and fetches no remote page.
Its local source-control receipts retain original posting/Job/run identifiers,
input URLs, extraction hashes and bounded saved-content samples. These receipts
and rejection/reset decisions survive job deletion and job-data purge, alongside
the source registry and locator queue. `source-proposals list` reads that history
without network access or mutations. See
[Discovery](discovery.md#propose-sources-from-saved-posting-history) for review and
explicit suppression reset.
