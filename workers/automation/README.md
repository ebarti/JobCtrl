# JobCtrl Automation Worker

This package contains JobCtrl's Python automation engine and CLI. It owns job
discovery, enrichment, scoring, tailoring, PDF generation,
profile import, and local browser apply automation.

See [Local Development](../../docs/local-development.md) for source setup and
the commands used to start the application and worker.

Provider generation runs through `agent-runtime-kit`. The worker owns the
persistent async service and idle runtime cache; provider SDKs remain optional
source/runtime packs. See `docs/architecture/agent-runtime.md` for request
isolation, reuse, permissions and shutdown.

Useful docs:

- root `README.md` for the public overview and quick start;
- `docs/user/getting-started.md` for setup and local stack commands;
- `docs/user/configuration.md` for environment variables;
- `docs/architecture/` and `docs/architecture/pipeline/` for internal
  runtime ownership.

Profile data, generated materials, browser state, logs, and SQLite databases
are sensitive local artifacts. Do not commit them or include them in public bug
reports.
