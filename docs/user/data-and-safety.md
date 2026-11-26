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

Returning visitors with valid consent and an active visitor cookie receive a new
session when their browser discards its session cookie. The existing consent
expiry still applies.

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

After entry, the compact **Demo guide** links to ordinary synthetic workspaces,
saved evidence, document/application review and history. Supported local edits
change only the synthetic browser workspace; simulated and unavailable external
actions are labeled. The demo does not contact employers, send messages or make
external application changes.

The Original redesign source-built demo also connects **Jobs**, **My profile**
and **Settings**, including peer Profile fields, local role/achievement removal
and restore, proposed wording revision/history, the standalone Requirements
library and Settings appearance. Its requirement meanings and posting
occurrences are authored synthetic examples. Manual links remain **user /
unassessed**. No assessed current-wording assignment or coverage is invented;
the demo retains its authored original wording and pending proposal separately.
Model refresh, meaning correction, current-assignment decisions, live job search
and Photon lookup remain unavailable. Typed location text stays unverified.
Supported real Plate editing/render/export remains browser-local synthetic work.
These source changes do not establish a hosted deployment.
The typed-requirement source candidate keeps reusable Skills/Professional
Experience examples separate from job-local Education/Languages demands, with
authored Language / Proficiency Profile rows and an equal-item formula. A
supported Skills section is not represented as a missing achievement expression.
These synthetic records cannot establish real-provider support or a live
workspace upgrade.

The updated source-built demo also offers **Explore matching and wording**,
which opens **How matching and wording work**, an interactive illustration with
synthetic catalog, evidence and
wording choices. Those choices change only the example: they make no model calls
and do not save Profile, match or approval changes to the browser-local workspace.
The actual **Update affected matches** action remains unavailable in the demo
and requires the local application. See the
[Product Tour](product-tour.md#affected-matches) for the entry path and the
[Profile update guide](candidate-profile.md#update-affected-matches) for the
real action's limits and recovery behavior. Source changes do not establish a
hosted deployment.

**Reset synthetic demo data** asks for confirmation, then
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
| `postgres/` | Workspace PostgreSQL cluster and selected generation; application data and DBOS execution state share its database. |
| `.jobctrl.db.llm-spend-pending/` | Private pending or unresolved provider-usage receipts. They contain model, lane and reported token counts, without prompts or completions. Keep them with the workspace when investigating incomplete accounting. |
| Earlier `jobctrl.db` and `temporal.db` files | Retained SQLite source and predecessor history after an upgrade. Preserve them and their companions. |
| PostgreSQL feature settings | Revisioned shared settings plus Profile, Discovery, Compensation and other feature-owned preferences. The historical `config.json` is not the current Python settings authority. No credential secret belongs in these records. |
| `.env` | Legacy/plaintext provider credentials used by remaining compatibility paths. Not encrypted at rest. |
| `codex_home/` | Stable JobCtrl-owned Codex CLI state. `auth.json` is outside the prompt-readable `workspace/` subtree. |
| `claude_home/`, `provider-packs/`, `provider-runtime/` | Isolated or separately acquired provider runtime state. |
| `tailored_resumes/` | Generated text, HTML, and PDF artifacts. |
| `profile-imports/` | Uploaded import PDFs retained for retry. The corresponding source-attempt bindings, which contain the digest and observed style but no PDF bytes, are in the workspace database. |
| `logs/`, `apply-workers/`, `chrome-workers/` | Logs and local browser/apply state, including CAPTCHA usage metadata when applicable. |
| `browser-profiles/` | Consented copied profiles retained for separate compatibility capabilities. Integrated `DiscoverWorkflow` never reads or launches them. Non-secret adoption metadata lives in `config.json`. |
| `extension-capability-token`, `extension-discovery-installation-id` | Private local browser-extension pairing secret and the extension installation selected for Discovery. Discovery bridge task bodies and results are memory-only and are not stored beside them. |
| `backups/` | Private backup and transition evidence. Older SQLite and Temporal snapshots may remain from earlier releases. See [Back Up And Restore](#back-up-and-restore). |
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

The redesigned editor recovery is separate from import-review records and from
minimal request-recovery metadata. Profile and retained application/resume
preference editors use version-2 non-secret changed-field patches rather than
full Profile/base snapshots. Those patches can still contain private experience
or resume text; protect browser storage and exports. Password/credential edits
stay only in session/tenant/section-scoped memory, survive ordinary navigation
and require saving before reload or close. The browser warns before reload/close while
they are unsaved; no secret-reload durability is promised. Safe restoration
preserves a canonical saved password.

Editing pauses until a retained copy is restored or discarded. Valid older
editor recovery migrates to a safe projection before the old key is removed;
malformed data stays paused with generic retry/explicit discard and is not
exposed as raw JSON. Owner/revision checks handle conflicting tabs. Plate offers
its own explicit restore/discard/retry controls. Synthetic demo copies use a
separate workspace/reset namespace and reset clears them. App appearance is a
separate presentation preference.

PDFs created with a Plate editor's **Export PDF** control are ordinary browser
downloads, so their destination is the download location selected by the
browser or operating system rather than `JOBCTRL_DIR`. JobCtrl does not register
that copy as a material artifact or use it to replace an accepted generation.

The development launcher writes PIDs and logs under the checkout's `.dev/`
directory; treat those logs as sensitive too.

### Back Up And Restore

A workspace backup must preserve the PostgreSQL database, including its DBOS
system tables, and the separately owned files, credentials and unresolved usage
receipts needed for recovery. A database snapshot alone is not a complete
workspace archive. The native lifecycle takes a cold database backup after
stopping owned writers; restore stages and verifies a new database generation
before selecting it. Native rollback also verifies the recorded identity and
byte digest of accepted PDFs; missing or changed files refuse selection. A
database archive cannot reconstruct those files. Preserve the current generation and recovery evidence if a
restore is refused or interrupted. Unresolved external effects and provider
charges must not be erased by restoring an older state.

The installed command is `jobctrl backup [--output DIRECTORY]`. The installed
`jobctrl rollback --to BUILD_ID` uses a retained backup for the selected
PostgreSQL release. Cross-engine rollback after PostgreSQL activation is refused;
the preserved SQLite source and recovery backups remain available for deliberate
recovery.

In a source checkout, `jobctrl --workspace PATH backup [--output FILE_OR_EXISTING_DIR]`
creates a private PostgreSQL custom archive with application and DBOS schemas
from one snapshot. It does not include workspace identity, files or credentials.
For inspection only, restore this archive into a new empty scratch database with
`pg_restore --exit-on-error --single-transaction --no-owner --no-acl`. JobCtrl
refuses to activate that physical clone; do not point the original workspace
at it. Native verified recovery is a separate operation. PostgreSQL tools come
from `JOBCTRL_POSTGRES_BIN_DIR` or PATH.

The source CLI can import the current Python SQLite workspace explicitly into PostgreSQL.
Desktop startup preserves an existing SQLite workspace and requires its verified upgrade before opening it.
Keep its source database, companions, predecessor workflow history and owned
artifacts. Rehearse into an isolated target first; stop old writers and drain
outstanding work before the final snapshot. Validation covers content and file
bindings before activation. Temporal histories are not replayed. Restoring a
pre-upgrade snapshot after later writes loses those later writes unless they are
separately reconciled. See [Local Development](../local-development.md#schema-migrations-and-source-updates)
and the [migration plan](../plans/2026-11-25-postgres-dbos.md).

<a id="typed-requirements-upgrade"></a>

The `requirements-v2` source upgrade is a separate generation boundary inside
the Python application. Before operational rollout, stop every old application
and worker writer and take a consistent workspace backup, including workflow
history and referenced accepted artifacts. Verify ownership and stopped
processes; do not treat a database-only snapshot as that complete backup.
A source implementation alone does not establish a release or operational rollout.

The new generation starts with an empty active Skills/Professional Experience
catalog. Legacy accepted rows, job revision ordering and accepted resume bytes
remain retained, while old results require refresh for the changed contract.
They cannot prove current ranking or composition readiness. Ordinary reads or
Profile saves do not run a conversion or model cascade. Incompatible old
operations are refused rather than resumed with mixed semantics.

After new-generation writes, rollback restores the verified pre-upgrade backup
as one workspace unit with compatible application/workflow state. Installing an
older binary alone is unsafe. Keep the backup and historical accepted artifacts
until the deliberate rollout and recovery checks have succeeded. No development
or QA instruction authorizes restoring or resetting a real user's workspace.

The later capability-consolidation policy stays within `requirements-v2` and
adds separate normalization records. It does not reset the catalog on startup.
Before adopting the source update, stop the owned writers and verify the same
paired workspace backup. **Consolidate skills** is an explicit model operation
over the complete retained catalog, including deleted-job sources. A successful
operation records stable identities, aliases and combined job demands atomically;
earlier meanings, assessments, approvals and accepted resume bytes remain
history. Refused, interrupted or cancelled work cannot partially replace them.
Changed derivations require an explicitly admitted refresh before they establish
current authority. Reads and Profile saves never start that work. See the
[Requirements library](requirements-library.md) for the action and recovery
behavior. After publication, rollback requires the compatible workspace backup
and workflow state together; an older binary alone is insufficient.

After a deliberate restore, restart JobCtrl and reload browser tabs; callers
using an explicit event cursor must start a fresh subscription. Do not hand
import individual tables or reset projection watermarks as a recovery shortcut.

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
privacy scan add safeguards. For shareable QA evidence, use the current
`corepack pnpm e2e` harness and inspect its synthetic output before sharing.
The former `qa:seed` command is retired; it is not a privacy or isolation control.
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
| Apply model and browser | Apply/dry-run work you start, or a standing loop you enable | The reviewed application URL and the page content observed during the transport-locked inspection. Profile fields, job-description prose, resume text, local artifact paths, and upload authority are excluded; see [Apply](apply.md#approval-and-automation-modes). |
| Salary data sources | At the end of a Discover run, only for benchmark slices that are missing or past their seven-day freshness window; Levels.fyi or Glassdoor only when their Settings policy permits | Requests for public benchmark data from Euro Top Tech, ECB exchange rates when a currency conversion is needed, and Eurostat price levels when a slice has no direct benchmark. Levels.fyi public-page URLs name the role and location being benchmarked. |
| Gmail | Authenticated verification, bounded outcome feedback, or an approved email application | Scoped queries/evidence or the exact approved recipient/attachment. |
| Google Maps | Profile location autocomplete with a configured key | Address text typed into the location field. |
| Photon / OpenStreetMap place lookup | Only after **Search map** in Search preferences; unavailable in the offline demo | Only the chosen location query. Typing, navigation and ordinary saves make no lookup request. Selecting a result saves its identity, coordinates and user-selection provenance locally; later label edits clear that binding. |
| CAPTCHA provider | Supported widget during an apply run you explicitly start or a standing loop you enable, with a configured solver | Site key and page URL through the owned local tool. |
| Langfuse/OpenTelemetry | Explicitly configured telemetry | Metadata-only LLM and workflow spans: provider/model, operation/stage, outcome, token counts, and safe sizes. |

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

Langfuse export is off unless configured. Its default is metadata-only LLM and
workflow spans. Set `LANGFUSE_DISABLE=1` to force opt-out.

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

From a source checkout, `corepack pnpm e2e` creates owned disposable synthetic
workspaces and records bounded evidence. It does not sanitize unrelated private
files. The release privacy
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

[Screening answers](screening-answers.md), selected source facts and manual-use text are private local database history. Only deliberate selected facts and exact saved question/posting context go to the configured Apply model lane. General activity and SSE carry safe references. Copying and manual-use attestation grant no form-entry or submission authority.

Optional [company briefings](company-briefings.md) fetch only explicitly selected anonymous public pages and send bounded public text plus the reviewed company identity to the enrichment model. They send no profile, mail, resume or search query. The local database retains source snapshots, model receipts and accepted/failure history; shared company history survives removal of its linked jobs.

## Selected-job comparison data

Reviewing a selected-job cohort is local and makes no model call. Explicit
comparison sends only the selected saved posting descriptions, their job
identifiers/title/employer context, and usable confirmed achievement excerpts
to your configured provider in the Profile lane. Personal contact fields,
unconfirmed evidence, declared skill lists, aspirations and milestone activity
are not comparison evidence inputs. No external learning-resource research runs.

Cohort revisions and chosen milestones retain private source snapshots,
comparison provenance and user completion statements in the local database. Historical
origins remain after Profile/cohort changes and job deletion. The job-data purge
preserves them and reports their retained `career_learning_records` count.
They are not sent in general SSE events or converted into Profile skills,
readiness, fit scores, application approvals or submission authority.

## Historical Discovery records

Upgrading keeps saved jobs, posting snapshots and earlier run receipts in the local workspace. JobStreaming supplies the board catalog for subsequent searches. A user-initiated posting URL import belongs to Jobs and retains its own receipt. [Discovery](discovery.md#capture-a-known-posting).
