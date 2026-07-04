# Documentation Index

## Public Project Docs

- [`../README.md`](../README.md): product overview, quick start, safety notes,
  command summary, and top-level documentation map.
- [`../ROADMAP.md`](../ROADMAP.md): public roadmap and open-source readiness
  direction.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md): contributor workflow, validation,
  documentation expectations, and PR standards.
- [`../SECURITY.md`](../SECURITY.md): supported security contact path and
  sensitive-data handling rules.
- [`../CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md): community standards.

## End-User Guides

- [`user/getting-started.md`](user/getting-started.md): install, configure, run,
  and seed a disposable workspace.
- [`user/configuration.md`](user/configuration.md): runtime variables,
  provider keys, local data paths, telemetry, browser automation, Gmail, and
  screenshot/test workspaces.
- [`user/normal-flows.md`](user/normal-flows.md): expected product flows from
  setup through review and apply.
- [`user/data-and-safety.md`](user/data-and-safety.md): local data boundaries,
  generated artifacts, and open-source sharing guidance.
- [`user/security.md`](user/security.md): security model, what leaves the
  machine, consent/control gates, credential storage, and the apply-agent
  threat model.
- [`user/screenshots.md`](user/screenshots.md): public screenshot generation
  command and covered UI surfaces.

## Developer Docs

- [`developer/README.md`](developer/README.md): contributor entry point and
  architecture/QA reading path.
- [`developer/security.md`](developer/security.md): trust boundary and threat
  model, locality enforcement, apply-path containment, secret/data hygiene, the
  `release_check.py` gate, and hosted-future security seams.
- [`architecture/index.md`](architecture/index.md): system shape,
  bounded-context composition, core data flow, and local commands — the System
  Architecture section map.
- [`architecture/runtime.md`](architecture/runtime.md): runtime boundaries —
  frontend, TypeScript product API, Python automation engine, local Temporal.
- [`architecture/observability.md`](architecture/observability.md): the
  OpenTelemetry → Langfuse export of LLM, workflow, and JSON-RPC spans.
- [`architecture/storage.md`](architecture/storage.md): SQLite layout and
  generated local files.
- [`architecture/scoring.md`](architecture/scoring.md): retrieval before
  scoring and the fit-assessment policy.
- [`architecture/materials.md`](architecture/materials.md): employer analysis,
  per-bullet provenance, voice pass + final audit, and the tailoring
  explanation read model.
- [`architecture/read-model.md`](architecture/read-model.md): apply feedback
  loop and read-model projections.
- [`architecture/pipeline/`](architecture/pipeline/index.md):
  workflow-by-workflow pipeline execution on Temporal — envelope and activities
  (`envelope.md`), stage walkthrough with sequence diagrams (`stages.md`), and
  operations, persistence, and events (`operations.md`).
- [`architecture/domain-model/`](architecture/domain-model/index.md): canonical
  DDD + hexagonal architecture (§1–§11 preserved across subpages): strategic
  and tactical design, ports, integration, persistence, cloud seams, risks,
  and glossary.
- [`architecture/frontend/`](architecture/frontend/index.md): canonical
  frontend architecture (§1–§15 preserved across subpages): contexts, patterns,
  state and ports, SSE realtime, integration, testing, folder structure, and
  reference.
- [`architecture/tailoring.md`](architecture/tailoring.md): resume tailoring
  prompt contract, generated JSON shape, validation/judge/fabrication gates,
  provenance, audit metadata, and safe change points.
- [`local-development.md`](local-development.md): setup, run, build, test, lint
  commands, and the synthetic documentation-screenshot workflow.
- [`local-ts-api.md`](local-ts-api.md): local TypeScript API, web app
  development notes, and the `GET /v1/events/stream` SSE contract.
- [`local-reliability-qa.md`](local-reliability-qa.md): local QA checklist,
  regression matrix, frontend test pyramid, and a11y bar.
- [`requirements.md`](requirements.md): product and technical requirements that
  must stay true as implementation changes.
- [`decisions.md`](decisions.md): accepted architecture decision records.
- [`backlog.md`](backlog.md): detailed engineering backlog and deferred work.
- [`plans/`](plans/): proposal and implementation records.
