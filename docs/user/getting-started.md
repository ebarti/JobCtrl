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

Open **Profile** in the web app and add or import the facts JobCtrl may use for
scoring and tailoring. Your profile is the source of truth for every later
stage; JobCtrl must not invent experience, skills, or achievements that are
not recorded there. [Candidate Profile](candidate-profile.md) explains the
profile's boundaries, versioning, and downstream consumers.

### Connect an LLM provider

Open **Settings → Credentials** and configure one provider:

- **Codex:** use an already authenticated Codex CLI, then verify it in JobCtrl.
- **Claude:** use an Anthropic API key or one of the guided Google Vertex,
  Amazon Bedrock, Claude Platform on AWS, or Microsoft Foundry routes.
- **Google:** use a Gemini API key or Vertex AI Application Default
  Credentials.

One ready provider is sufficient for scoring, materials, and employer
analysis. Connecting a second provider can improve ensemble diversity, but it
is a recommendation, not a requirement.

Claude and Google values saved to the native credential store take effect when the
relevant Python process next starts. Restart JobCtrl after those edits:

```bash
jobctrl stop
jobctrl start
```

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

After any required credential-store restart, verify the effective configuration:

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

## 4. Run Your First Workflow

Use the web app to configure discovery targets, inspect jobs and scores, edit
generated materials, rehearse a dry run, and approve any live submission.
[Daily Workflow](normal-flows.md) walks through the complete supervised loop.

For a quick terminal-side readiness check:

```bash
jobctrl doctor
jobctrl pipeline-status
jobctrl runs
```

Start with a dry run. JobCtrl does not submit in dry-run mode, and live
submission remains behind the configured approval gate.

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

A compatible source checkout and installed app use the same workspace, profile,
resume and Temporal history. Older installed releases have limits: v0.3.1 supports
schema 14 and expects Temporal history at `$JOBCTRL_DIR/temporal.db`, not the
older source location `$JOBCTRL_DIR/temporal/temporal.db`. Do not move or delete
history to force compatibility. A newer checkout can upgrade the shared database
beyond what an older installed release understands; update the installed app when
a compatible release is published. Source upgrade and recovery details are in
[Local Development](../local-development.md#schema-migrations-and-source-updates).

A release that moves to schema 15 uses its new authenticated installer to
upgrade the original installation. Direct installed upgrades require an initialized
schema-14 or schema-15 workspace and its original installation metadata. Older
schemas must first reach schema 14 through a supported predecessor; preserve the
workspace and see the [v0.3.1 upgrade notes](https://github.com/ebarti/JobCtrl/releases/tag/v0.3.1). Keep the original installation metadata and
databases: the installer verifies them, stops instance-owned processes, backs up
the current application and Temporal databases together, and applies the additive
migration before checking startup health. Normal cleanup and restart do not
require rebooting. If cleanup fails, preserve the reported evidence.

If startup fails or the upgrade is interrupted, JobCtrl preserves the live
databases and recovery journal. Rerun the trusted new installer that began the
upgrade if the old `jobctrl` command remains selected or reports an unreadable
transition journal. The old binary cannot recover the new journal. After the
new command has replaced it, run `jobctrl stop`, then `jobctrl update` to continue
forward. Each attempt backs up the current pair, including later saved changes.
A revoked candidate can still be stopped through the new command; revocation
continues to block its startup or update. If a legacy runtime lacks complete
ownership records, JobCtrl cannot currently verify a safe recovery automatically
and has no documented self-service procedure for it. Preserve the registry,
workspace and journal, and seek support. Restarting the computer alone does not
clear this refusal. Do not remove the journal, reinstall over a schema-14
workspace without its original metadata, or restore an older snapshot over newer
data. Rollback across this protocol change is refused. A same-protocol explicit rollback still
restores the snapshot associated with its previous release, so data added since
that snapshot is not carried backward. Automatic paired rollback is also
unavailable while a workspace uses the legacy source Temporal history path;
the live workspace and backup are preserved. A source merge or synthetic test does
not publish an upgrade; the signed installer must pass release qualification
before installed users receive it.

Rollback keeps a compatible launcher for recovery while restoring the older
application. Homebrew commands preserve that selection until you explicitly run
`jobctrl update` again. If an older updater reports a failed candidate and cannot
restart its previous release, recovery depends on the transition state and the
available compatible controller. The installer and formula also handle an
installation you have never started. If an existing database/history pair is
incomplete, updating refuses
to replace it; preserve those files and recover the pair before retrying.


## Semantic Determination Authority

Capabilities that interpret text require a ready provider and spend allowance. Saved settings drive provider search directly, and fetched jobs proceed to full-posting analysis/scoring without a separate model intake gate. Generation preserves accepted artifacts on failed refreshes. The extension proposes model-mapped, saved-profile-backed answers for review before filling. Affected offline-demo capabilities report unavailable.

See [the decision](../decisions.md#_2026-10-07-semantic-judgments-are-llm-determinations) for caching, provenance and failure contracts.
