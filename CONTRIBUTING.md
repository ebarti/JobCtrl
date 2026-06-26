# Contributing

Thanks for helping improve JobHunter. This project handles job-search data,
resumes, generated application materials, browser state, local logs, and
credentials, so contributions need to preserve privacy and local safety first.

## Development Setup

```bash
pnpm dev:setup
uv --project workers/automation run jobhunter doctor
pnpm dev
```

The full local stack runs in the foreground and starts Temporal, the TypeScript
API, the Vite web app, and the Python worker. Keep that terminal open while
using the app.

Use a disposable workspace for destructive or screenshot-oriented testing:

```bash
pnpm qa:seed -- /tmp/jobhunter-qa
JOBHUNTER_DIR=/tmp/jobhunter-qa pnpm dev
```

## Pull Requests

- Keep changes scoped to one behavior or documentation concern.
- Use Conventional Commits for commit messages and PR titles.
- Update documentation when public behavior, commands, runtime requirements,
  configuration, architecture, or QA expectations change.
- Do not commit local user data, `.env` files, resumes, PDFs, logs, browser
  profiles, SQLite databases, or generated application materials.

## Validation

Run the narrowest useful checks while iterating. Before opening a PR, prefer:

```bash
pnpm check
pnpm test
uv --project workers/automation run --extra dev python -m build workers/automation
git diff --check
```

For user-facing UI/API/product-flow changes, include a product-path QA step, not
only unit tests. See [docs/local-reliability-qa.md](docs/local-reliability-qa.md)
for the regression matrix.
