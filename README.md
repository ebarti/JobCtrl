<div align="center">

# JobCtrl

**Local job-search automation. You approve every application.**

[Live demo](https://demo.jobctrl.dev) · [Docs](https://jobctrl.dev) ·
[Comparison](https://jobctrl.dev/comparison) ·
[Help test](https://github.com/ebarti/JobCtrl/discussions/797)

[![TypeScript CI](https://github.com/ebarti/JobCtrl/actions/workflows/typescript.yml/badge.svg)](https://github.com/ebarti/JobCtrl/actions/workflows/typescript.yml)
[![Release Privacy Gate](https://github.com/ebarti/JobCtrl/actions/workflows/release-check.yml/badge.svg)](https://github.com/ebarti/JobCtrl/actions/workflows/release-check.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

<img src="docs/assets/screenshots/dashboard.png" alt="JobCtrl dashboard with pipeline health, active work, review queues, and recent activity (synthetic data)" width="880" />

<sub>The screenshot uses synthetic data.</sub>

</div>

JobCtrl finds job postings, scores each one against your profile, writes a
tailored resume and cover letter, and prepares the application for your review.
Your data lives in `~/.jobctrl/` on your machine; there is no account and no
hosted backend.

## Install

Early access. The signed release runs on Apple-silicon Macs with macOS 15 or
later and bundles its own runtimes.

```bash
curl -fsSL https://jobctrl.dev/install.sh | sh
# or: brew install ebarti/tap/jobctrl
```

In a new terminal, run `jobctrl start` to start the local services and open the
app. Create your profile, then connect an LLM provider (Codex, Claude, or
Google) under **Settings → Credentials**; JobCtrl uses your own provider
account. After saving Claude or Google credentials, restart with `jobctrl stop`
and `jobctrl start`. Then run `jobctrl setup` and fix any `MISSING` rows in its
report.

To get your first jobs, set target roles on the **Discovery** page and start a
run from **Pipelines**. [Getting Started](https://jobctrl.dev/user/getting-started)
covers first-run setup in detail. `jobctrl uninstall` removes JobCtrl and keeps
`~/.jobctrl/` unless you add `--remove-data`.

## What It Does

1. **Discover:** searches job boards and configured company sources for your
   target roles, locations, and seniority.
2. **Enrich:** fetches the full posting and its apply link.
3. **Score:** rates fit from 1 to 10 by checking each requirement against your
   profile evidence.
4. **Tailor:** writes a resume and cover letter from your profile. Each resume
   bullet links to the profile fact behind it. Drafts that invent a metric,
   date, title, or employer fail validation.
5. **Review:** you edit the resume on the **Apply review** page and approve the
   exact version for that application.
6. **Apply:** a dry run inspects the application form and submits nothing; it
   needs Claude and a Chrome or Chromium browser enabled in Settings. You fill
   in and submit browser forms yourself. The only applications JobCtrl submits
   itself are emails from your Gmail, with the recipient and attachment you
   approved, sent at most once.

Steps 1–4 run on Temporal, a workflow engine, and resume after a crash or
restart.

JobCtrl also shows posted salaries and market estimates with their evidence,
records application outcomes, keeps contacts, and drafts outreach for you to
send. Explore the local [interview question library and job preparation](https://jobctrl.dev/user/materials-and-tailoring#interview-preparation);
its guidance is a research draft, and personal prep remains in beta.

## Safety

- Auto-apply is off by default. When on, it sends the email applications you
  approved; browser forms still wait for you to complete and submit them.
- A confirmed application to an opening blocks further submissions to it. An
  equivalent role at the same employer needs your explicit confirmation.
- A daily LLM budget, $25 by default, stops new LLM work once JobCtrl's own
  estimate of the day's spend reaches it.
- The local API binds to 127.0.0.1 by default. Don't expose it to a network:
  it serves your profile, jobs, and documents.
- Discover queries Indeed, LinkedIn, and ZipRecruiter by default and does not
  check robots.txt. Automated access can violate a site's terms; disable any
  source you are not allowed to query automatically.

## What Leaves Your Machine

Nothing, until you run a step that needs an outside service:

- **LLM providers:** posting text, relevant profile evidence, and generated
  text. During a dry run, Claude also sees the application page, but never your
  profile or documents.
- **Job boards and other sites:** Discover, Enrich, and dry-run requests, plus
  opt-in contact research. With the browser extension paired and connected,
  Discover and Enrich run in your Chrome session and carry its cookies.
- **Salary data sources:** when a benchmark is missing or over a week old, a
  Discover run fetches public data from Euro Top Tech, plus ECB exchange rates
  and Eurostat price levels when needed; Levels.fyi or Glassdoor only if you
  enable them.
- **Gmail, if connected:** verification-code and outcome lookups, and the
  application emails you approve.
- **Google Maps** (address autocomplete), **CapSolver** (CAPTCHA solving), and
  **Langfuse** (metadata-only traces): only if you configure them.

Details: [Data, Privacy & Safety](https://jobctrl.dev/user/data-and-safety) ·
[Security](https://jobctrl.dev/user/security)

## Documentation

[Getting Started](https://jobctrl.dev/user/getting-started) ·
[Daily Workflow and CLI reference](https://jobctrl.dev/user/normal-flows) ·
[Configuration](https://jobctrl.dev/user/configuration) ·
[Architecture](https://jobctrl.dev/architecture/) ·
[Developer Guide](https://jobctrl.dev/developer/) ·
[Roadmap](ROADMAP.md) · [Contributing](CONTRIBUTING.md) ·
[Security policy](SECURITY.md)

## Development

```bash
git clone https://github.com/ebarti/JobCtrl.git && cd JobCtrl
scripts/install        # install the toolchain and dependencies
corepack pnpm check    # typecheck and lint
corepack pnpm test     # run the test suites
corepack pnpm dev      # run the full stack; keep this terminal open
```

See [Local Development](docs/local-development.md).

## License

[AGPL-3.0-only](LICENSE). Copyright (C) 2026 Eloi Barti. See [NOTICE](NOTICE).
