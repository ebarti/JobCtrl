# Documentation Index

JobCtrl is publicly released. [GitHub Releases](https://github.com/ebarti/JobCtrl/releases/latest)
identifies the latest published version; source versions and pending release
work do not establish what installed users receive. For installation and
upgrade instructions, see [Getting Started](user/getting-started.md).
Historical launch plans and incomplete verification gates do not mean the
product is unpublished. The source documentation describes the Python application
and its feature contracts. Source changes and their verification do not establish
what an installed release already includes.

## Public Project Docs

- [`../README.md`](../README.md): short product overview, install quick start,
  safety summary, and top-level documentation map.
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
- [`comparison.md`](comparison.md): why choose JobCtrl, with a dated,
  evidence-backed comparison of 19 source-reviewed and commercial job-search,
  resume, application, and career alternatives.
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
  facts, preferences, attestations, approved wording, and manual updates to
  affected matches after saved changes.
- [`user/discovery.md`](user/discovery.md): target search, source registry,
  runtime controls, schedules, crawl policy, and SQLite ownership.
- [`user/enrichment-and-extraction.md`](user/enrichment-and-extraction.md): job
  capture, extraction, normalization, deduplication, snapshots, and provenance.
- [`user/scoring-and-employer-analysis.md`](user/scoring-and-employer-analysis.md):
  fit evidence, shared requirement matching, factual support versus wording
  coverage, policy, corrections, and ranking; it consumes the employer analysis
  owned by Discovery.
- [`user/company-briefings.md`](user/company-briefings.md): optional public-source company context, explicit identity links, bounded CLI refresh and shared job/interview/digest reads.
- [`user/materials-and-tailoring.md`](user/materials-and-tailoring.md): generated
  materials, provenance, validation, review, and accepted-artifact history.
- [`user/locale-variants.md`](user/locale-variants.md): source-linked translations,
  independent reviews and accepted locale exports.

- [`user/screening-answers.md`](user/screening-answers.md): reviewed reusable answers and application-bound history.
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
- [`developer/releasing.md`](developer/releasing.md): version preparation, curated release notes, protected publication, and public-channel verification.
- [`developer/local-scale-benchmark.md`](developer/local-scale-benchmark.md):
  historical synthetic production-path benchmark; remeasure the transformed
  runtime before treating its results as current.
- [`developer/qa/regression-catalog.md`](developer/qa/regression-catalog.md):
  risk families, invariants, and regression proof.
- [`developer/qa/doctor-diagnostics.md`](developer/qa/doctor-diagnostics.md):
  CLI diagnostic coverage, status meaning, platform modes, and verification limits.
- [`developer/qa/browser-smoke.md`](developer/qa/browser-smoke.md): browser smoke
  assertions.
- [`developer/qa/frontend.md`](developer/qa/frontend.md): frontend verification
  and accessibility guidance; use the Python journey ledger for the target suite.
- [`developer/first-run-ttfv.md`](developer/first-run-ttfv.md): first-run
  time-to-value validation protocol.
- [`developer/qa/complete-checklist.md`](developer/qa/complete-checklist.md):
  product and high-risk verification checklist.
- [`developer/qa/python-journeys.md`](developer/qa/python-journeys.md): target
  E2E journeys, observed-result ledger and separate operational proof.

### How JobCtrl Works

- [`architecture/index.md`](architecture/index.md): Python target system map
  and feature composition.
- [`architecture/runtime.md`](architecture/runtime.md): Python application,
  worker and launcher ownership, lifetimes and readiness.
- [`architecture/agent-runtime.md`](architecture/agent-runtime.md): historical
  provider runtime design; verify its integration with the Python model gateway
  before treating those implementation details as current.
- [`architecture/pipeline/`](architecture/pipeline/index.md): Python feature
  actions and preparation, Temporal execution, retries, scheduling and recovery.
- [`architecture/data-events-and-projections.md`](architecture/data-events-and-projections.md):
  the distinction between domain state, events, projections, and telemetry.
- [`architecture/storage.md`](architecture/storage.md): physical SQLite and file
  authorities.
- [`architecture/portable-workspace.md`](architecture/portable-workspace.md): future
  proposal (not implemented) for owned workspace bundles and safe import.
- [`architecture/application-url-authority.md`](architecture/application-url-authority.md):
  historical exact-v10 URL authority inventory. The Python target assigns job
  and application sources to their [feature owners](architecture/domain-model/strategic.md).
- [`architecture/read-model.md`](architecture/read-model.md): feature-owned
  reads, application feedback and composed views.
- [`architecture/scoring.md`](architecture/scoring.md): person qualification,
  requirement evidence, score resolution and wording-coverage separation.
- [`architecture/reviewed-screening-answers.md`](architecture/reviewed-screening-answers.md):
  historical screening architecture; the Python Applications owner and
  [screening guide](user/screening-answers.md) describe the target workflow.
- [`architecture/materials.md`](architecture/materials.md): employer analysis
  and cross-artifact auditability.
- [`architecture/material-locale-variants.md`](architecture/material-locale-variants.md):
  source-bound translation authority, registry persistence and export fences.
- [Leadership Practice — future architecture (not implemented)](architecture/leadership-practice.md):
  bounded management reflection and experiments.
- [`architecture/tailoring.md`](architecture/tailoring.md): complete approved
  baseline composition, coverage, advisory review and acceptance.
- [`architecture/contracts-types-and-api-boundaries.md`](architecture/contracts-types-and-api-boundaries.md):
  Python feature services, schema ownership and public API boundaries.
- [`architecture/frontend/`](architecture/frontend/index.md): frontend system
  overview; numbered deep references are listed below.
- [`architecture/observability.md`](architecture/observability.md): model
  accounting, operational evidence and diagnostic-export verification limits.

### Reference

- [`local-ts-api.md`](local-ts-api.md): local Python API and cross-cutting
  conventions; the documentation URL is retained.
- [`api/profile-and-settings.md`](api/profile-and-settings.md),
  [`api/jobs-and-materials.md`](api/jobs-and-materials.md), and
  [`api/operations-and-events.md`](api/operations-and-events.md): focused API
  semantics by route family.
- [`api/complete-contract.md`](api/complete-contract.md): target route-family
  index and shared HTTP, error and event boundaries; integrated verification is
  in progress.
- [`architecture/domain-model/`](architecture/domain-model/index.md): Python
  feature ownership, tactical invariants, public ports, integration,
  persistence and explicitly future cloud considerations.
- [`architecture/frontend/`](architecture/frontend/index.md): canonical
  frontend design (§1–§15), split into contexts, structure, patterns, state and
  ports, realtime, integration, testing, and reference.

## Repository-Only Project Records

These documents remain in the repository but are not separate site sections:

- [`requirements.md`](requirements.md): product and technical invariants.
- [`decisions.md`](decisions.md): accepted architecture decision records.
- [GitHub Issues](https://github.com/ebarti/JobCtrl/issues): actionable work; [migration index #881](https://github.com/ebarti/JobCtrl/issues/881) accounts for the historical backlog.
- [`claims-ledger.md`](claims-ledger.md): public product claims and supporting references.
- [`plans/`](plans/): active proposals and immutable implemented-plan history.
  The active [sensitive-artifact retention and cleanup
  proposal](plans/sensitive-artifact-retention.md) defines the unshipped local
  inventory, preservation, preview, containment, and recovery contract tracked
  by issue #887.
- [Profile multi-source intake design (#1013)](plans/2026-09-21-profile-evidence-selective-tailoring.md#2-current-foundations-and-acceptance-map):
  current import/editor limitation and proposed
  source reconciliation with explicit human acceptance; not implemented.
- [`plans/local-custom-provider-contract.md`](plans/local-custom-provider-contract.md):
  design-only, fail-closed contract and proof gates for a future local/custom
  LLM provider; the capability is currently unavailable.
- [`incidents/`](incidents/): incident records and corrective actions.
- [`research/interview-preparation/README.md`](research/interview-preparation/README.md):
  canonical interview research draft, source-reading ledger, question guidance,
  synthetic examples, and catalog authoring contract; rehearsal and validated
  grading remain future work.
