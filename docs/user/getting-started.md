---
description: "Install JobCtrl on Apple-silicon macOS, explore the live demo, configure providers, and run your first private, supervised job-search workflow."
---

# Getting Started

JobCtrl is a local application: the app, database, settings, and generated
files stay on your computer unless you explicitly connect an external provider.
Install it once, then use the same `jobctrl` command from any directory.

::: warning Early access
JobCtrl is publicly released and available to install in early access. See
[GitHub Releases](https://github.com/ebarti/JobCtrl/releases/latest) for the
latest published version; the source checkout can contain unreleased changes.
The public version began at `0.1.0` after the pre-launch `2.0.x` numbering was
withdrawn so
the version reflects the product's actual maturity. That change did not
downgrade product behavior, local data, database schemas, launcher protocols,
signed-release safety, or security controls.
:::

::: tip Want to explore before installing?
Open the [live demo](https://demo.jobctrl.dev) for an interactive workspace
with synthetic browser-local data, or use the [Product Tour](product-tour.md)
for a screen-by-screen walkthrough.
:::

## What You Need

- For the bundled installer or Homebrew: an Apple-silicon Mac running macOS 15
  or newer.
- Internet access for installation, updates, and any hosted providers you
  choose to connect.
- One supported LLM provider before you run scoring or material generation:
  Codex, Claude, or Google.

The bundled install includes JobCtrl's application runtimes, workflow engine,
PDF tooling, and managed headless browser. A system Chrome or Chromium
installation is optional and used only by capabilities that explicitly adopt
an authenticated browser.

## 1. Install JobCtrl

Choose one acquisition method. The installer and Homebrew formula resolve the
same signed JobCtrl release and provide the same `jobctrl` command. These public
acquisition paths currently target Apple-silicon macOS. Native Windows is not
yet a supported public installation path.

### Recommended: bundled installer

```bash
curl -fsSL https://jobctrl.dev/install.sh | sh
```

The public install link follows the latest stable release’s pinned bootstrap.
The installer selects the current stable Apple-silicon build, verifies it,
places the versioned runtime under your user account, and adds `jobctrl` to
your shell path. Open a new terminal if the command is not available in the
terminal that ran the installer.

### Homebrew

```bash
brew install ebarti/tap/jobctrl
```

Homebrew installs the same signed release identity. It does not build JobCtrl
from source or install a separate developer toolchain.
Homebrew verifies strict Developer ID signatures in its build sandbox. When a
cached release is first activated, the normal-user bootstrap checks Apple
notarization before running the installer; the installer verifies the complete
runtime before activation. No Homebrew sandbox patch is required.

### Build and run from source

Use the source option when you want to inspect, modify, or contribute to the
codebase:

```bash
git clone https://github.com/ebarti/JobCtrl.git
cd JobCtrl
scripts/install
corepack pnpm dev
```

Only this option requires Git, Node.js 22.13 or newer, and the rest of the
source-development toolchain. Keep the
`corepack pnpm dev` terminal open while using the source build and stop it with
Ctrl-C. See [Local Development](../local-development.md) for prerequisites,
isolated workspaces, component commands, and contributor QA.

## 2. Start JobCtrl

After a bundled or Homebrew install, start the complete local application from
any directory:

```bash
jobctrl start
```

JobCtrl waits for its local services to become healthy and opens the app in
your browser. The following lifecycle commands use the same installed binary:

```bash
jobctrl status
jobctrl open
jobctrl logs worker
jobctrl stop
```

Use `jobctrl start --no-open` when you do not want a browser window, or
`jobctrl start --foreground` when another process should supervise JobCtrl.
Your workspace is stored under `~/.jobctrl/` by default and survives stops,
updates, and rollbacks.

If the local workflow engine's health check does not answer, startup reports a
deadline failure and status can show the engine as unhealthy even when its
process is still running. Status includes the bounded health diagnostic. If
probe cleanup cannot be verified, status exits with an error and keeps the
unverified ownership receipt; preserve it and use `jobctrl stop` to retry cleanup.

`jobctrl stop` requests a clean shutdown, terminates verified leftovers that
exceed the timeout, and waits for exit. It tracks the instance's children even
if they detach or their parent crashes. Successful cleanup permits normal
restart. If a process, permission check or ownership record prevents cleanup,
JobCtrl reports that failure and blocks backup or restart until it is resolved.
Check `jobctrl status`, keep the registry and workspace intact, and investigate
the reported problem. Older untracked registries remain ownership-unverified;
do not delete them to force a successful status. Reboot is last-resort manual
troubleshooting for an unrecoverable cleanup problem, not a normal requirement.

## 3. Complete First-Run Setup

### Create your profile

Open **My profile → Experience** in the source-built web app and add or import the facts JobCtrl may use for
scoring and tailoring. Your profile is the source of truth for every later
stage; JobCtrl must not invent experience, skills, or achievements that are
not recorded there. [Candidate Profile](candidate-profile.md) explains the
profile's boundaries, versioning, and downstream consumers.

### Connect an LLM provider

Open **Settings → Connections** and configure one provider. Existing credentials,
models and browser deep links reveal their corresponding connection panel:

- **Codex:** use an already authenticated Codex CLI, then verify it in JobCtrl.
- **Claude:** use an Anthropic API key or one of the guided Google Vertex,
  Amazon Bedrock, Claude Platform on AWS, or Microsoft Foundry routes.
- **Google:** use a Gemini API key or Vertex AI Application Default
  Credentials.

One ready provider is sufficient for scoring, materials, and employer
analysis. Connecting a second provider can improve ensemble diversity, but it
is a recommendation, not a requirement.

The Python source candidate resolves saved native credentials for each new
provider execution. Saving does not require a routine worker restart; an
in-flight request keeps the credential it started with. Inspect readiness after
the save rather than assuming that configured credentials establish model
access. Installed availability remains tied to the published version.

If the active provider route is owned by a non-empty environment variable,
Settings keeps that active secret and its removal control read-only. You may
configure another supported auth route in the same provider card, but it does
not replace the environment-owned route until you remove the environment value
and restart the relevant process.

You can also store provider settings in `~/.jobctrl/.env`. See
[Configuration](configuration.md) for provider choices, precedence, and
budgets. Apply-specific browser, CAPTCHA, and Gmail setup is in
[Apply](apply.md).

### Verify provider readiness

After saving provider configuration, or restarting after a launch-environment
change, verify the effective configuration:

```bash
jobctrl setup
jobctrl doctor
```

`jobctrl doctor` reports local setup checks without printing secret values. It
exits zero even when a row says `MISSING`; check the rows before starting work.
Its provider and connection checks do not run a job or verify external service
requests. Employer analysis uses whichever configured provider is ready; Claude
is no longer a mandatory synthesis dependency.

The web app does not require `jobctrl init`. Run it only if you want starter
files for terminal-driven workflows:

```bash
jobctrl init
```

For a new workspace, the wizard's Remote choice starts with LinkedIn and
ZipRecruiter because Indeed cannot combine Remote with the 72-hour lookback.
On a rerun, the wizard retains the existing Profile. Edit it in the web app if
you want to change it. Saved Profile target roles and location/work-model rows
take precedence over the corresponding Discovery rows entered in the wizard.
Existing resume files, AI settings, and Apply automation settings are also kept
unless you choose to change them. A selected resume replacement is saved only
after Discovery is accepted. Adding an AI credential retains other `.env`
settings. Turning off the standing Apply loop does not change your separate
approval choice.
The wizard keeps saved boards, lookback and other controls while
replacing the location and title rows it asks you to enter. If a saved board
cannot support the new target, change that board or target and retry; the
rejected settings stay unchanged.
If a saved tier or location-label filter would exclude every resulting search,
the wizard shows the conflicting filter and asks whether to clear it. Declining
leaves the Discovery settings unchanged; confirming clears only that filter.

## 4. Run Your First Workflow

The Original redesign source candidate starts in **Jobs**. Open **My profile →
Search preferences** to save roles, locations, work arrangements, boards and
limits. Return to **Jobs → Search for jobs**, review effective criteria and
readiness, then choose **Start search**. Filtering saved jobs is a separate
action. Saving preferences or fixing a connection does not launch work.

Compare the resulting Jobs table, open one job, choose tailored or full-baseline
**Prepare resume**, edit in the real Plate editor, review/accept the document,
then rehearse and review its application. Final browser submission stays manual.
[Daily Workflow](normal-flows.md) walks through the complete supervised loop.
The [redesign ledger](../plans/2026-11-11-original-app-redesign.md) records exact
candidate verification; the published release determines installed availability.

For a quick terminal-side readiness check:

```bash
jobctrl doctor
jobctrl pipeline-status
jobctrl runs
```

Start application work with a dry rehearsal. Discovery itself has no dry-run
mode. JobCtrl does not submit in an application rehearsal, and live submission
retains its exact approval and ownership gates.

## Discovery Extension And Optional Managed-Browser Capabilities

Discovery and Enrich work with or without the JobCtrl extension. When the
selected paired installation is connected, acquisition prefers its bounded
page/API transport in your current Chrome profile. Otherwise it uses guarded
public HTTP or anonymous managed Playwright. Availability is checked before
acquisition; a failed fetch does not switch transports. Anonymous access obeys
site restrictions and may be unable to read signed-in content. Neither mode
copies a profile or adopts a system-browser executable. PDF rendering and Apply
retain their separate browser capabilities and consent requirements.

Open **Settings → Browser & extension** to enable an optional system-browser
capability, or to pair the extension. JobCtrl passively detects supported
Chrome/Chromium installations for this screen, returning only a stable browser
kind and label—not the local executable path. Detection does not launch, adopt,
or persist a browser. Choose a detected browser and select **Enable** to adopt
it explicitly; JobCtrl resolves it again at enable time and fails closed if it
is no longer available. **Advanced: enter executable path** remains the manual
fallback when no supported installation is listed.

The extension also saves the current job page and reviews model-mapped
profile-backed autofill suggestions. It talks only to JobCtrl's loopback API
and cannot submit an application by itself. Pair it from the same Settings tab
using the local browser-extension token, then wait for the separate live status
to show connected before starting Discover. A displayed token alone does not
prove the installed extension is active.

## Update, Roll Back, Or Remove JobCtrl

```bash
jobctrl update
jobctrl rollback
jobctrl uninstall
```

Updates and rollbacks preserve `~/.jobctrl/`. Uninstall also preserves your
data unless you explicitly request and confirm removal with
`jobctrl uninstall --remove-data`.

Run `jobctrl update` to acquire a new published release. JobCtrl does not
currently install updates in the background or display an update-available
notification; check GitHub Releases for new versions. Homebrew installations
use the updated formula, while bundled-installer installations use their signed
release channel. Pulling source changes does not publish an update to installed
users.

For Homebrew installations, `brew upgrade ebarti/tap/jobctrl` updates the
formula while retaining the existing workspace.

::: warning Python transformation is not yet released
The accepted Python transformation uses a new workspace and deliberately
preserves the full Profile and supporting sources only. Existing jobs, generated
materials, workflow history and other non-Profile data are not migrated. The
old workspace remains untouched; development and QA must not reset live user
data. The target database has application ID `1245926228` and user version `1`.

The source transition uses the explicit `profile-transfer` command with a
read-only source, a nonexistent new target, a complete browser Profile sources
manifest and `--confirm-profile-only-reset`. Verify the completed receipt before
selecting the new workspace.

An installed cutover also needs a **separate fresh native runtime home** with no
active release selection. Preserve both the old workspace and its native runtime
home. The authenticated candidate installer must first stage into the new runtime
home; its bundled Python performs the transfer, and the same installer then makes
the first selection with `JOBCTRL_DIR` pointing to the new workspace. This is a
release-qualified operation, not a command to run with today's published version.
The native installer supports `--stage-only --home`; the public install shell does
not forward `--stage-only`.

Only a verified, unused transfer may start without workflow history. First native
selection consumes that permission once. If interrupted after consumption, keep
the target for inspection or repeat the explicit transfer into a different
nonexistent target; do not remove the selection marker to retry. Reusing an old
runtime home or a used transfer cannot authorize missing-history recovery.
Do not treat a source checkout or synthetic smoke as a published upgrade; signed
acquisition, predecessor compatibility and release qualification remain separate
gates.

For later target-to-target updates, the new runtime preserves live workspace
state. If an update is interrupted, stop the owned runtime and resume forward;
do not automatically restore an old database over newer writes. An explicit
rollback requires an allowed release and a verified target database/history
pair. Unresolved model accounting blocks rollback until reconciled. Preserve
the current data, journal, backups and accounting evidence when recovery is
uncertain.
:::

For released versions, use the release-specific installation and recovery
instructions. A source merge does not publish an installed update.

## Semantic Determination Authority

Capabilities that interpret text require a ready provider and spend allowance. Saved settings drive provider search directly, and fetched jobs proceed to full-posting analysis/scoring without a separate model intake gate. Generation preserves accepted artifacts on failed refreshes. The extension proposes model-mapped, saved-profile-backed answers for review before filling. Affected offline-demo capabilities report unavailable.

See [the decision](../decisions.md#_2026-10-07-semantic-judgments-are-llm-determinations) for caching, provenance and failure contracts.
