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

## Privacy Quick Answer

| Question | Answer |
| --- | --- |
| Do I need a hosted backend or a JobCtrl account? | ✕ **No.** App, API, worker, database, and files run locally. |
| Are the database and generated files stored locally? | ✓ **Yes, by default.** They live under `JOBCTRL_DIR` (normally `~/.jobctrl/`). |
| Does JobCtrl call AI models or other providers automatically? | ◐ **Only when you use a configured feature.** Generation and opted-in research call providers during runs you start or schedules you explicitly enable. |
| Does Discovery make network requests? | ✓ **Yes—that is how it searches configured job sources and, for AI-assisted steps, communicates with the model providers you selected.** Requests occur during runs you start or schedules you explicitly enable. |
| Is product telemetry enabled by default? | ✕ **No.** Langfuse requires configuration; `LANGFUSE_DISABLE=1` overrides it. |
| Does this documentation site use analytics? | ◐ **Only after you accept.** The optional Google Analytics tag stays unloaded until you choose **Accept analytics**; declining keeps the documentation fully available. |
| Can Discovery or enrichment launch a browser? | ◐ **Only when needed.** Smart extraction and some detail enrichment use Playwright during runs you start or schedules you explicitly enable. |
| Does application-submission browser automation run continuously? | ✕ **No.** It starts only through apply/dry-run work you initiate or a standing loop you explicitly enable. |
| Does JobCtrl submit applications or send employer-facing email by default? | ✕ **No.** Browser submission and Gmail application sending are explicit guarded actions. |
| Does Outreach send messages automatically? | ✕ **No.** Drafts end at copy/export; send logs are user attestations. |

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
[me@eloibarti.com](mailto:me@eloibarti.com). This hosted documentation
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
For privacy questions, contact [me@eloibarti.com](mailto:me@eloibarti.com).

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

After entry, the compact **Demo guide** links to seeded scoring evidence,
tailored-material review, Apply Review/dry-run, and run history. Every shortcut
and action is simulated; it does not contact employers, send messages, or make
external changes. **Reset synthetic demo data** asks for confirmation, then
replaces the browser-local workspace with the original examples.
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
| `jobctrl.db` plus `-wal` / `-shm` | Profile, jobs, discovery settings, events, projections, artifact metadata, review drafts, contacts, and workflows. Treat all three files as one database. |
| `temporal.db` plus `-wal` / `-shm` | Bundled-runtime Temporal state. During a native bundled update or rollback, it is hash-snapshotted and restored only together with `jobctrl.db`; never restore just one member of that pair. |
| `config.json` | Non-secret Settings values: general controls, provider configuration metadata, preferred model IDs, compensation source policy, and browser-adoption metadata. No API keys or feed contents. |
| `.env` | Legacy/plaintext provider credentials used by remaining compatibility paths. Not encrypted at rest. |
| `codex_home/` | Stable JobCtrl-owned Codex CLI state. `auth.json` is outside the prompt-readable `workspace/` subtree. |
| `claude_home/`, `provider-packs/`, `provider-runtime/` | Isolated or separately acquired provider runtime state. |
| `tailored_resumes/`, `cover_letters/` | Generated text, HTML, and PDF artifacts. |
| `logs/`, `apply-workers/`, `chrome-workers/` | Logs and local browser/apply state, including CAPTCHA usage metadata when applicable. |
| `browser-profiles/` | Consented copied browser profiles. Non-secret adoption metadata lives in `config.json`. |
| `extension-capability-token` | Private local browser-extension pairing secret. |
| `backups/` | Timestamped SQLite snapshots created by `jobctrl backup`. |
| `gmail/` | Gmail OAuth client and token files. |
| Baseline/legacy resume files | `resume.txt`, `resume.pdf`, and older local style/template files. |

The development launcher writes PIDs and logs under the checkout's `.dev/`
directory; treat those logs as sensitive too.

### Credentials Outside The Workspace

The macOS credential panel guides Codex, Claude, and Google setup. Codex uses
the stable, separate `$JOBCTRL_DIR/codex_home`. Codex-backed work requires
an authenticated Codex CLI first. If its `auth.json` is absent,
setup or generation may copy valid authentication once from the effective
normal Codex CLI home. JobCtrl never overwrites existing isolated auth or
changes the normal home. The auth file remains outside
`codex_home/workspace/`, the only JobCtrl Codex subtree available to
prompt-driven reads.
Anthropic and Gemini API keys plus cloud activation flags/non-secret identifiers
can live in Keychain; AWS, Google, and Azure credential files remain in their
vendor stores. After environment-file loading, Python loads a Keychain entry at
startup only when that environment value is missing or empty. Any non-empty
environment value already present wins. Restart JobCtrl after saving or removing
a value.

Windows Credential Manager and Linux Secret Service/keyring adapters are
planned; those platforms use `.env` or shell variables today. The panel returns
status, never stored values. Unknown (`inspection_failed`) means Keychain could
not be inspected—not that a credential is absent. If Keychain is locked, unlock
it and retry.

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

Draft bodies, gate results, and claim provenance stay local. An approved draft
can be copied/exported; JobCtrl has no outreach send transport. Logging a send
records something you did. Follow-ups are reminders and never act automatically.

## External Services

| Service | When used | Data involved |
| --- | --- | --- |
| LLM providers | Scoring, employer analysis, materials, contact extraction, stored interview prep | Posting text, relevant profile evidence, generated text, or opted-in fetched page text. |
| Job boards, ATS APIs, posting pages | Discovery and enrichment | Search terms, URLs, and page/API requests. |
| Apply model and browser | Apply/dry-run work you start, or a standing loop you enable | Apply prompt, reviewed materials, profile application fields, and page interaction. |
| Gmail | Authenticated verification, bounded outcome feedback, or an approved email application | Scoped queries/evidence or the exact approved recipient/attachment. |
| Google Maps | Profile location autocomplete with a configured key | Address text typed into the location field. |
| CAPTCHA provider | Supported widget during an apply run you explicitly start or a standing loop you enable, with a configured solver | Site key and page URL through the owned local tool. |
| Langfuse/OpenTelemetry | Explicitly configured telemetry | Metadata-only LLM, workflow, and JSON-RPC spans: provider/model, operation/stage, outcome, token counts, and safe sizes. |

Review [Security → What Leaves Your Machine](security.md#what-leaves-your-machine)
before enabling a provider.

## Responsible Use Boundaries

- **Employer actions are irreversible.** Rehearse with dry-run, review current
  materials and field mappings, and keep `applyApprovalRequired` enabled.
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

- live apply requires a current bound approval by default;
- system-browser apply is disabled until you explicitly enable and adopt the
  `auto-apply-browser` capability;
- Settings may detect a supported browser for display, but detection is
  read-only and exposes only an ID/label pair. JobCtrl does not launch, copy,
  persist, or adopt it until you explicitly select and enable that capability;
- dry-run has a browser-layer network/submission guard;
- submit intent is checkpointed so crashes do not cause blind retries;
- email-only applications use the same reviewed binding; and
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

Langfuse export is off unless configured. When enabled, it exports metadata-only
LLM, workflow, and JSON-RPC spans. Raw prompts, messages, job/profile/material
text, completions, credentials, local paths, logs, and database content are not
exported as span attributes. Set `LANGFUSE_DISABLE=1` to force opt-out.

## Public Bug Reports

Use synthetic data. Never attach real profiles/resumes, databases, secrets,
OAuth tokens, generated artifacts, local paths, raw logs, or prompt traces.

From a source checkout, `corepack pnpm qa:seed` creates a disposable workspace.
The release privacy
check scans for secret/profile needles, blocked file types, and unsafe
distribution paths before publication, but it cannot protect a private file you
manually copy into a new tracked path.
