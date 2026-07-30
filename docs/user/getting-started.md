---
description: "Install JobCtrl on Apple-silicon macOS, explore the live demo, configure providers, and run your first private, supervised job-search workflow."
---

# Getting Started

JobCtrl is a local application: the app, database, settings, and generated
files stay on your computer unless you explicitly connect an external provider.
Install it once, then use the same `jobctrl` command from any directory.

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

### Build and run from source

Use the source option when you want to inspect, modify, or contribute to the
codebase:

```bash
git clone https://github.com/ebarti/JobCtrl.git
cd JobCtrl
scripts/install
corepack pnpm dev
```

Only this option requires Git and the source-development toolchain. Keep the
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

Claude and Google values saved to Keychain take effect when the
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

After any required Keychain restart, verify the effective configuration:

```bash
jobctrl setup
jobctrl doctor
```

`jobctrl doctor` reports readiness without printing secret values. Employer
analysis uses whichever configured provider is ready; Claude is no longer a
mandatory synthesis dependency.

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

## Optional Browser Capabilities

The bundled managed browser covers discovery, enrichment, PDF rendering, and
other headless core workflows. Install or adopt a system Chrome/Chromium
profile only when you explicitly enable an authenticated-browser or auto-apply
capability that needs it.

Open **Settings → Browser & extension** to enable an optional system-browser
capability, or to pair the extension. JobCtrl passively detects supported
Chrome/Chromium installations for this screen, returning only a stable browser
kind and label—not the local executable path. Detection does not launch, adopt,
or persist a browser. Choose a detected browser and select **Enable** to adopt
it explicitly; JobCtrl resolves it again at enable time and fails closed if it
is no longer available. **Advanced: enter executable path** remains the manual
fallback when no supported installation is listed.

The optional extension can save the current job page and review deterministic
profile-backed autofill suggestions. It talks only to JobCtrl's loopback API
and cannot submit an application by itself. Pair it from the same Settings tab
using the local browser-extension token.

## Update, Roll Back, Or Remove JobCtrl

```bash
jobctrl update
jobctrl rollback
jobctrl uninstall
```

Updates and rollbacks preserve `~/.jobctrl/`. Uninstall also preserves your
data unless you explicitly request and confirm removal with
`jobctrl uninstall --remove-data`.
