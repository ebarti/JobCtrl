# JobHunter Automation Worker

This package contains JobHunter's Python automation engine and CLI. It owns job
discovery, enrichment, scoring, tailoring, cover letters, PDF generation,
profile import, and local browser apply automation.

Use it from the repository root through `uv`:

```bash
uv --project workers/automation run jobhunter doctor
uv --project workers/automation run jobhunter run
uv --project workers/automation run jobhunter worker
```

The full local application is normally started from the repository root with
`pnpm dev`, which runs Temporal, the TypeScript API, the React web app, and this
worker together.

Useful docs:

- root `README.md` for the public overview and quick start;
- `docs/user/getting-started.md` for setup and local stack commands;
- `docs/user/configuration.md` for environment variables;
- `docs/architecture/` and `docs/architecture/pipeline/` for internal
  runtime ownership.

Profile data, generated materials, browser state, logs, and SQLite databases
are sensitive local artifacts. Do not commit them or include them in public bug
reports.
