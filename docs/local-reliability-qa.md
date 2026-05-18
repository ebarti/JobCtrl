# Local Reliability QA

Use this checklist for changes that affect local API behavior, the React UI,
Python automation, generated artifacts, profile/settings persistence, or apply
flows.

## Required Commands

```bash
pnpm test
pnpm qa:test
uv --project workers/automation run --extra dev pytest -q
uv --project workers/automation run --extra dev ruff check .
git diff --check
```

For browser smoke, run the local API and web app:

```bash
pnpm api:dev
pnpm web:dev -- --port 5173
```

For destructive browser QA, seed a disposable workspace:

```bash
pnpm qa:seed -- /tmp/jobhunter-qa
JOBHUNTER_DIR=/tmp/jobhunter-qa pnpm api:dev
VITE_JOBHUNTER_API_BASE_URL=http://127.0.0.1:8766 pnpm web:dev -- --port 5173
```

## High-Risk Regression Areas

| Risk | Automated coverage |
| --- | --- |
| Dry run marks a job applied | `workers/automation/tests/test_apply_regressions.py` |
| Apply process hangs while stdout stays open | `workers/automation/tests/test_apply_regressions.py` |
| Targeted apply skips fresh jobs | `workers/automation/tests/test_apply_regressions.py` |
| Stages cannot be retried individually | `workers/automation/tests/test_state_dashboard.py` |
| Explicit stage state loses to legacy columns | `workers/automation/tests/test_state_dashboard.py` |
| Pipeline actions write events to a different DB, hide running stages, or ignore bounded stage limits | `apps/api/test/json-rpc-adapter.test.ts`; `workers/automation/tests/test_pipeline_observability.py`; `apps/web/src/contexts/pipeline/components/StageTriggerPanel.test.tsx`; `apps/web/src/contexts/operations/invalidation-router.test.ts` |
| PDF conversion publishes stray files | `workers/automation/tests/test_pdf_targets.py` |
| Cover letters use the wrong resume | `workers/automation/tests/test_cover_requirements.py` |
| Profile PDF import corrupts defaults | `workers/automation/tests/test_profile_import.py` |
| API list filtering/sorting/pagination regresses | `apps/api/test/server.test.ts` |
| Jobs delete/hide lifecycle regresses, causing temporary deletes not to resurface or hidden jobs to leak into active/deleted views | `apps/api/test/server.test.ts`; `workers/automation/tests/test_discovery_identity.py`; `apps/web/src/views/jobs/JobBulkActions.test.tsx`; `apps/web/src/views/jobs/JobsView.test.tsx` |
| Destructive UI workflows touch real user data | `apps/api/test/qa-workflow.test.ts` with `pnpm qa:seed` |
| Source registry compatibility drops legacy discovery config | `workers/automation/tests/test_source_registry.py` covers packaged `sites.yaml` migration, `employers.yaml` migration, JobSpy `boards` selection, and the one-release legacy `sites` alias warning |
| Source quality stops feeding discovery budgets or dashboard health | `workers/automation/tests/test_discovery_scheduler_pr4.py`; `workers/automation/tests/test_source_quality_projection_pr4.py`; `apps/web/src/views/dashboard/SourceHealthCard.test.tsx`; `apps/web/src/contexts/operations/invalidation-router.test.ts` |
| Discovery product controls stop recording source/quarantine/manual-capture feedback safely, mislabel locator candidates, or preview quarantine residue as source leads | `apps/api/test/discovery-controls.test.ts`; `apps/web/src/contexts/discovery/components/DiscoveryProductControls.test.tsx` |
| Preferences Target search stops driving discovery roles, location fallback, Spain/Europe source filtering, or API-visible source controls | `workers/automation/tests/test_target_search_preferences.py`; `apps/api/test/discovery-controls.test.ts` |
| Discovery RFC production wiring stops auto-approving located parseable sources, feeding API-visible manual queues, canonical ATS ingestion, manual-capture imports, snapshot persistence, or acceptance evidence | `workers/automation/tests/test_discovery_production_wiring.py` uses a Barcelona/Spain tech-leadership fixture and report covering lead yield, candidate sources, manual-action count, canonical verification rate, duplicate/quarantine counts, source-quality updates, and scoring handoff count |
| Hybrid retrieval picks stale or weak candidates before LLM scoring | `workers/automation/tests/test_hybrid_search_index.py`; `workers/automation/tests/test_scorer.py::test_run_scoring_preselects_retrieval_top_k_before_llm` |
| Scoring prompt/schema/model changes silently regress parse validity, bands, blockers, ranking, or correction agreement | `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_scoring_eval*.py`; update the synthetic scoring fixtures or document why a scoring change does not affect them |

## Frontend QA

The `apps/web` test pyramid follows the strategy defined in
[`docs/frontend-target.md`](frontend-target.md) §10. Run the layers via the
commands listed under the "Frontend" section of
[`docs/local-development.md`](local-development.md).

### Coverage layout

| Layer | Files | Purpose |
| --- | --- | --- |
| Unit / hook / component (Vitest + RTL + MSW) | `*.test.ts(x)` files under `apps/web/src/` | Pure selectors, query-key factories, the invalidation router (32 handlers — one per `DomainEvent` variant), every Operations read hook, every per-aggregate mutation hook (success path + rollback path), forms, drawers, filter bars. |
| Type-level tests (Vitest `typecheck` mode via `vitest.types.config.ts`) | 9 `*.test-d.ts` files under `apps/web/test/types/` | Inferred shapes of the eight Operations read hooks plus `useActivityEventQuery`. The original plan named `tsd`; the implementation uses Vitest's typecheck mode — same artifact (typed test files), same gate, integrated runner (cf. target §10.6). |
| End-to-end (Playwright headless) | 8 specs in `apps/web/e2e/tests/` (`dashboard`, `dry-run`, `jobs-bulk`, `jobs-drawer`, `materials`, `profile-edit`, `settings`, `wizard`) | One spec per critical flow (target §10.4) against a real `apps/api` + a seeded SQLite fixture. `materials.spec.ts` is `test.fixme`'d pending the `GenerateMaterialsUseCase` backend exposure (tracked in `docs/backlog.md`). |
| A11y suites (Vitest + `axe-core` + `jest-axe`) | 9 `*.a11y.test.tsx` files | Form, dialog, drawer, sheet, and command components — fails on critical violations (target §10.7). |

### Parity tests

Two parity tests are the runtime backstop to the compile-time guarantees the
type system provides; each lives next to its subject:

| Test | Location | What it asserts | Mirror |
| --- | --- | --- | --- |
| `every-event-has-handler.test.ts` | `apps/web/src/contexts/operations/` | Every `DomainEvent["eventType"]` variant has a registered handler in `invalidation-router.ts`, and the handler body is not the obvious empty stub `() => []`. | Backstop to `Record<DomainEvent["eventType"], InvalidationHandler>` — target §7.4. Mirrors the backend's `scripts/check-domain-type-parity.py` pattern. |
| `every-stage-state-has-badge.test.tsx` | `apps/web/src/contexts/pipeline/components/` | Every `STAGE_STATE_KINDS` value is rendered by a non-default `<StageBadge>` arm. | Backstop to the exhaustive `switch (state.kind)` in `<StageBadge>` — target §10.2. |

### Accessibility bar

The Storybook `addon-a11y` is configured so that **critical** and **serious**
axe violations fail CI (`a11y: { test: "error" }`). The Storybook test runner
(`pnpm web:storybook:test`) is the gate; `pnpm --filter @jobhunter/web test`
also runs the colocated `*.a11y.test.tsx` suites for forms and dialogs.

17 stories defer the a11y check (`a11y: { test: "off" }`) because they
exercise pre-existing production a11y defects that are scoped out of the
Phase 7 baseline. Each deferral is tracked in
[`docs/backlog.md`](backlog.md) "Frontend Accessibility Backlog (Phase 7
Deferrals)" with the affected production file and the defect type.

### Storybook gate

`pnpm web:storybook:build` produces the static Storybook bundle;
`pnpm web:storybook:test` serves it with `http-server` and runs
`test-storybook` over every story. A story that throws on render, fails its
`play()` interaction, or surfaces a critical / serious axe violation fails
the gate.
