# Documentation Index

## Public Project Docs

- [`../README.md`](../README.md): product overview, quick start, safety notes,
  command summary, and top-level documentation map.
- [`../ROADMAP.md`](../ROADMAP.md): public roadmap and open-source readiness
  direction.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md): contributor workflow, validation,
  documentation expectations, and PR standards.
- [`../DESIGN.md`](../DESIGN.md): AI-readable design-system tokens, brand
  assets, and UI generation guidance.
- [`../SECURITY.md`](../SECURITY.md): supported security contact path and
  sensitive-data handling rules.
- [`../CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md): community standards.

## Published Guide

The documentation site exposes one guide to every reader. The folders below
are stable source and URL locations, not separate audience silos. Each concept
has one defining page; other pages summarize it briefly and link to that owner.

### Start Here

- [`index.md`](index.md): documentation homepage and product entry points.
- [`comparison.md`](comparison.md): evidence-backed comparison with alternative
  job-search workflows and tools.
- [`user/product-tour.md`](user/product-tour.md): visual product tour.
- [`user/getting-started.md`](user/getting-started.md): install, first-run setup,
  provider readiness, first workflow, update, rollback, and removal.
- [`user/normal-flows.md`](user/normal-flows.md): the complete supervised daily
  workflow and the web/CLI surfaces for each step.

### Guides

- [`guides/index.md`](guides/index.md): practical guide hub and reading paths.
- [`guides/local-first-job-search-automation.md`](guides/local-first-job-search-automation.md):
  local storage, deliberate network boundaries, durable workflows, and user
  control.
- [`guides/open-source-job-application-tracker.md`](guides/open-source-job-application-tracker.md):
  application records, evidence, canonical identity, outcomes, and open-source
  inspectability.
- [`guides/resume-tailoring-without-fabrication.md`](guides/resume-tailoring-without-fabrication.md):
  source authority, candidate selection, rendered validation, and accepted
  artifact history.
- [`guides/evidence-based-job-fit-scoring.md`](guides/evidence-based-job-fit-scoring.md):
  applicant-side requirement evidence, deterministic score resolution,
  confidence, eligibility, and corrections.
- [`guides/at-most-once-job-application-submission.md`](guides/at-most-once-job-application-submission.md):
  binding approval, durable submit intent, ambiguity, and manual browser
  submission.
- [`guides/temporal-workflows-desktop-app.md`](guides/temporal-workflows-desktop-app.md):
  durable local orchestration, workflow identity, retries, projections, and
  recovery.

### The Job-Search Lifecycle

- [`user/candidate-profile.md`](user/candidate-profile.md): canonical candidate
  facts, preferences, attestations, versions, and downstream consumers.
- [`user/discovery.md`](user/discovery.md): target search, source registry,
  runtime controls, schedules, crawl policy, and SQLite ownership.
- [`user/enrichment-and-extraction.md`](user/enrichment-and-extraction.md): job
  capture, extraction, normalization, deduplication, snapshots, and provenance.
- [`user/scoring-and-employer-analysis.md`](user/scoring-and-employer-analysis.md):
  fit evidence, requirement assessment, policy, corrections, and ranking; it
  consumes the employer analysis owned by Discovery.
- [`user/materials-and-tailoring.md`](user/materials-and-tailoring.md): generated
  materials, provenance, validation, review, and accepted-artifact history.
- [`user/apply.md`](user/apply.md): application fields, approval and automation
  modes, browser capabilities, Gmail, and follow-up controls.
- [`user/outcomes-and-feedback.md`](user/outcomes-and-feedback.md): application
  outcomes, timelines, analytics, feedback, and projection boundaries.
- [`user/contacts-and-outreach.md`](user/contacts-and-outreach.md): contact facts,
  supervised research, provenance, outreach drafts, and sending boundaries.
- [`user/compensation-evidence.md`](user/compensation-evidence.md): compensation
  extraction, public and licensed sources, normalization, and confidence.

### Configuration & Trust

- [`user/configuration.md`](user/configuration.md): non-secret settings,
  credentials, effective-value ownership, provider/model choices, and budgets.
- [`user/data-and-safety.md`](user/data-and-safety.md): local data inventory,
  outbound data boundaries, retention, and responsible use.
- [`user/security.md`](user/security.md): user-visible guarantees, hardening,
  approval gates, credential storage, and reporting.
- [`developer/security.md`](developer/security.md): threat model, enforcement
  points, apply-path containment, release gates, and future security seams.

### Build & Verify

- [`developer/README.md`](developer/README.md): contributor start and reading
  router.
- [`developer/repository-and-ownership-map.md`](developer/repository-and-ownership-map.md):
  repository surfaces, bounded-context owners, and change routing.
- [`local-development.md`](local-development.md): install, run, build, lint,
  troubleshooting, and documentation-screenshot workflows.
- [`developer/documentation-standards.md`](developer/documentation-standards.md):
  concept ownership, page structure, terminology, diagrams, and stable surfaces.
- [`local-reliability-qa.md`](local-reliability-qa.md): validation-path chooser.
- [`developer/qa/regression-catalog.md`](developer/qa/regression-catalog.md):
  risk families, invariants, and regression proof.
- [`developer/qa/browser-smoke.md`](developer/qa/browser-smoke.md): browser smoke
  assertions.
- [`developer/qa/frontend.md`](developer/qa/frontend.md): frontend test layers
  and accessibility bar.
- [`developer/first-run-ttfv.md`](developer/first-run-ttfv.md): first-run
  time-to-value validation protocol.
- [`developer/qa/complete-checklist.md`](developer/qa/complete-checklist.md):
  exhaustive local QA checklist.

### How JobCtrl Works

- [`architecture/index.md`](architecture/index.md): current system map and
  bounded-context composition.
- [`architecture/runtime.md`](architecture/runtime.md): process ownership,
  lifetimes, readiness, and TypeScript-to-Python boundaries.
- [`architecture/pipeline/`](architecture/pipeline/index.md): Temporal workflow
  catalog, stage execution, activities and retries, concurrency, scheduling,
  operations, and recovery.
- [`architecture/data-events-and-projections.md`](architecture/data-events-and-projections.md):
  the distinction between domain state, events, projections, and telemetry.
- [`architecture/storage.md`](architecture/storage.md): physical SQLite and file
  authorities.
- [`architecture/read-model.md`](architecture/read-model.md): apply feedback and
  projection details.
- [`architecture/scoring.md`](architecture/scoring.md): scoring algorithm,
  evidence, policy, and calibration.
- [`architecture/materials.md`](architecture/materials.md): employer analysis
  and cross-artifact auditability.
- [`architecture/tailoring.md`](architecture/tailoring.md): resume-tailoring
  prompt and validation contract.
- [`architecture/contracts-types-and-api-boundaries.md`](architecture/contracts-types-and-api-boundaries.md):
  schema ownership and cross-process contract boundaries.
- [`architecture/frontend/`](architecture/frontend/index.md): frontend system
  overview; numbered deep references are listed below.
- [`architecture/observability.md`](architecture/observability.md): telemetry,
  traces, propagation, and Langfuse export.

### Reference

- [`local-ts-api.md`](local-ts-api.md): route-family chooser and cross-cutting
  TypeScript API conventions.
- [`api/profile-and-settings.md`](api/profile-and-settings.md),
  [`api/jobs-and-materials.md`](api/jobs-and-materials.md), and
  [`api/operations-and-events.md`](api/operations-and-events.md): focused API
  semantics by route family.
- [`api/complete-contract.md`](api/complete-contract.md): exhaustive wire-level
  route, field, status, error, and Server-Sent Events contract.
- [`architecture/domain-model/`](architecture/domain-model/index.md): canonical
  backend design (§1–§11), split into strategic design, tactical design, ports,
  integration, persistence, explicitly future cloud seams, and reference.
- [`architecture/frontend/`](architecture/frontend/index.md): canonical
  frontend design (§1–§15), split into contexts, structure, patterns, state and
  ports, realtime, integration, testing, and reference.

## Repository-Only Project Records

These documents remain in the repository but are not separate site sections:

- [`requirements.md`](requirements.md): product and technical invariants.
- [`decisions.md`](decisions.md): accepted architecture decision records.
- [`backlog.md`](backlog.md): detailed engineering backlog and deferred work.
- [`claims-ledger.md`](claims-ledger.md): launch-claim evidence and status.
- [`plans/`](plans/): active proposals and immutable implemented-plan history.
- [`incidents/`](incidents/): incident records and corrective actions.
