# Contributing

Thanks for helping improve JobCtrl. This project handles job-search data,
resumes, generated application materials, browser state, local logs, and
credentials, so contributions need to preserve privacy and local safety first.

## Development Setup

```bash
scripts/install
corepack pnpm dev
```

`scripts/install` is the clean-machine setup path: it checks the required
system tools, offers to install missing Homebrew dependencies (including the
standalone Corepack package required by current Homebrew Node), syncs Node and
Python packages, and installs the Playwright browsers. When Corepack is already
available, `corepack pnpm install:interactive` invokes the same script. Use
`dev:setup` only when those system tools and browsers are already installed.
The full local stack runs in the foreground and starts Temporal, the TypeScript
API, the Vite web app, and the Python worker. Keep that terminal open while
using the app.

The web app does not require a CLI profile. When contributing to CLI workflows,
initialize one and run the diagnostic explicitly:

```bash
uv --project workers/automation run jobctrl init
uv --project workers/automation run jobctrl doctor
```

Use a disposable workspace for destructive or screenshot-oriented testing:

```bash
corepack pnpm qa:seed /tmp/jobctrl-qa
JOBCTRL_DIR=/tmp/jobctrl-qa corepack pnpm dev
```

## Pull Requests

- Keep changes scoped to one behavior or documentation concern.
- Use Conventional Commits for commit messages and PR titles.
- External contributors should sign off every commit with the Developer
  Certificate of Origin trailer.
- Update documentation for changed public behavior.
- Do not commit local user data, `.env` files, resumes, PDFs, logs, browser
  profiles, SQLite databases, or generated application materials.
- CI eligibility follows each executable workflow's events and path filters,
  including fork PRs and each stack layer. All external fork contributors require
  maintainer approval before their workflows run. There is no top-of-stack scheduler; see
  [the CI reference](docs/local-development.md#pull-request-ci).

## Issue Labels And Project Status

Project 7's `Status` field is the only progress source for issues and pull
requests. Labels classify the work by `type:`, `area:`, or a specific
`privacy:` or `release:` flag. Labels, titles, authors, priority, and Project
Status describe work; none of them grants permission to implement, merge,
release, deploy, submit an application, or change user data.

Issue forms assign their explicit type and, where fixed by the form, their
area. The triage workflow adds at most one missing type and one missing area,
never replaces a maintainer's type or area, and does nothing to closed issues.
Privacy review is limited to the security-contact form or reports that name
both a sensitive object and how it was exposed. Release impact is assigned only
from the checked release-impact field.

The supported classification labels live in
`scripts/issue-label-catalogue.mjs`. Event triage creates a declared label only
when it is missing; it does not rewrite existing label colors or descriptions.
To report catalogue drift without changing GitHub, run:

```bash
GH_TOKEN="$(gh auth token)" node scripts/issue-label-maintenance.mjs catalogue \
  --snapshot /tmp/jobctrl-label-catalogue-preview.json
```

The same tool previews existing assignment cleanup. It removes an open item's
progress `status:` labels only when Project 7 has one unambiguous `Status` and
retains the legacy `status: needs validation` and `execution: not admitted`
semantics. It canonicalizes only the legacy `bug`, `documentation`,
`enhancement`, and `question` aliases when they do not conflict with a manual
type, and preserves all other labels, assignees, Project fields, and item state.
Closed-item or privacy corrections must be named individually with
`--reviewed-remove`, an expected state, a reason, and an expected Project Status
when a progress label is involved.

Every command defaults to dry-run and retains before/after state in the named
snapshot. `--apply` is the explicit write boundary. Applying catalogue drift or
assignment cleanup requires the same scoped authorization as any other GitHub
metadata change; neither command deletes label definitions.

## Developer Certificate of Origin Sign-Off

External contributor pull request commits must include a `Signed-off-by:`
trailer. This is a DCO sign-off that says you have the right to submit the
contribution; it is separate from GPG or SSH commit signing. Repository-owner
PRs are exempted by GitHub actor in CI so maintainer email addresses do not need
to be published in workflow configuration.

Use `git commit -s` for new commits:

```bash
git commit -s -m "fix: describe the change"
```

If you already made a commit, amend or rebase it before pushing:

```bash
git commit --amend -s --no-edit
git rebase --signoff origin/main
```

## Validation

Frontend changes also follow [apps/web/AGENTS.md](apps/web/AGENTS.md).

Run the touched-surface commands in
[Reliability & QA](docs/local-reliability-qa.md) plus `git diff --check`. Add the
cross-stack aggregates only for cross-stack, release/high-risk, or plan-required
work; build the Python package only when package/distribution behavior changes.

For user-facing UI/API/product-flow changes, include a product-path QA step, not
only unit tests. See [docs/local-reliability-qa.md](docs/local-reliability-qa.md)
for the regression matrix.
