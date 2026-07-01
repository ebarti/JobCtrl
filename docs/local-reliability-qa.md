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

For worker-backed pipeline smoke, run the full local stack and confirm
`GET /v1/health` reports `worker.status: "healthy"` before starting stages:

```bash
pnpm dev
```

`pnpm dev` is the attached full-stack launcher; keep it running while exercising
the UI and stop it with Ctrl-C when the QA pass is finished.

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
| Auto-apply kills the launcher on agent timeout, uploads files outside the worker sandbox, loops on browser Gmail, or cannot report Gmail connector auth readiness | `workers/automation/tests/test_claude_code_cli_adapter.py`; `workers/automation/tests/test_apply_prompt_builder.py`; `workers/automation/tests/test_apply_use_cases.py`; `workers/automation/tests/test_gmail_mcp_config.py`; `workers/automation/tests/test_doctor_gmail_mcp.py` |
| Stages cannot be retried individually | `workers/automation/tests/test_state_dashboard.py` |
| Explicit stage state loses to compatibility columns | `workers/automation/tests/test_state_dashboard.py` |
| Pipeline actions write events to a different DB, hide running stages, miss in-flight workflow stop controls, ignore bounded stage limits, selected job URL sets, or selected Discover source IDs, leave bulk-retried failed jobs or pending preparation backlogs dependent on page-local pickup, show opaque Discover `0/N` progress while a source is mid-crawl, duplicate a long-running Discover activity after timeout, or leave stopped source runs marked active | `apps/api/test/server.test.ts`; `apps/api/test/json-rpc-adapter.test.ts`; `workers/automation/tests/test_runtime_identity.py`; `workers/automation/tests/test_jsonrpc_handlers.py`; `workers/automation/tests/test_rpc_handlers_apply_workflow.py`; `workers/automation/tests/test_pipeline_observability.py`; `workers/automation/tests/test_discovery_limits.py`; `workers/automation/tests/test_workflow_job_pipeline.py`; `workers/automation/tests/test_orphaned_stage_recovery.py`; `apps/web/src/contexts/pipeline/components/StageTriggerPanel.test.tsx`; `apps/web/src/contexts/pipeline/components/CancelWorkflowRunButton.test.tsx`; `apps/web/src/contexts/pipeline/hooks/useCancelWorkflowRunMutation.test.ts`; `apps/web/src/contexts/pipeline/hooks/useRunPendingPreparationMutation.test.ts`; `apps/web/src/views/jobs/JobsView.test.tsx`; `apps/web/src/views/runs/RunsTable.test.tsx`; `apps/web/src/contexts/operations/invalidation-router.test.ts` |
| Operational metrics collapse scraper, manual abort, reload, orphan cleanup, harness, and unknown failures into one failed status | `workers/automation/tests/test_operational_metrics.py`; `workers/automation/tests/test_orphaned_stage_recovery.py`; `apps/api/test/projections.test.ts` |
| PDF conversion publishes stray files | `workers/automation/tests/test_pdf_targets.py` |
| Cover letters use the wrong resume | `workers/automation/tests/test_cover_requirements.py` |
| Resume tailoring accepts a merely validation-passing resume, ignores generator/judge routing, hides judge rejection or high-fit adversarial blockers as success, fails to retry non-blocking review warnings while budget remains, omits auditable source-vs-tailored change annotations, requirement-led coverage graph metadata, generated-claim mappings, review-blocking adjacent/draft labels, mandatory covered-achievement overflow reasons, actionable keyword coverage counts, persona prompt/response/score audit, or expandable LLM request/response trails for persona warnings, lets low-signal marketing tokens pollute tailoring keywords, persists unsafe provider config, accepts unsupported metrics or keyword stuffing, drops profile evidence controls, or lets CLI/RPC/Temporal/API contracts drop tailoring model controls | `workers/automation/tests/test_requirement_led_tailoring.py`; `workers/automation/tests/test_materials_quality_eval.py`; `workers/automation/tests/test_materials_quality.py`; `workers/automation/tests/test_materials_adversarial.py`; `workers/automation/tests/test_materials_use_cases.py`; `workers/automation/tests/test_content_validator.py`; `workers/automation/tests/test_tailor_retailor.py`; `workers/automation/tests/test_activity_tailor.py`; `workers/automation/tests/test_actions.py`; `workers/automation/tests/test_jsonrpc_handlers.py`; `workers/automation/tests/test_llm_port.py`; `apps/api/test/application-feedback.test.ts`; `apps/api/test/json-rpc-adapter.test.ts`; `apps/web/src/contexts/profile/components/StructuredProfileEditor.test.tsx` |
| Voice pass runs after (not before) the final audit, audits/coverage diverge from the rendered/PDF text, a voiced bullet is not recorded as the `voice` transform, the never-fabricate detector/provenance are not re-run after voice (a voice-introduced unsourced metric ships), keyword coverage is inferred from the job description or counts an ungrounded keyword-stuffed line as covered, or a voice error/regression sinks the otherwise-approved resume instead of falling back to the clean pre-voice candidate | `workers/automation/tests/test_voice_metrics.py`; `workers/automation/tests/test_voice_payload.py`; `workers/automation/tests/test_voice_adapter.py`; `workers/automation/tests/test_coverage_audit.py`; `workers/automation/tests/test_tailor_voice_audit_integration.py`; `apps/api/test/projections.test.ts` |
| Profile PDF import corrupts defaults or drops tailoring claim/evidence controls | `workers/automation/tests/test_profile_import.py`; `workers/automation/tests/test_profile_aggregate.py`; `workers/automation/tests/test_sqlite_profile_repository.py`; `apps/web/src/contexts/profile/components/StructuredProfileEditor.test.tsx` |
| API list filtering/sorting/pagination or shared data-grid filtering/sorting/pagination/column resizing regresses | `apps/api/test/server.test.ts`; `apps/web/src/shared/ui/filterable-data-grid.test.tsx`; `apps/web/src/views/debug/DebugActivityTable.test.tsx` |
| Dashboard KPI drilldowns stop matching their Jobs list filters | `apps/api/test/server.test.ts`; `apps/web/src/views/dashboard/KpiGrid.test.tsx`; `apps/web/src/views/jobs/JobsView.test.tsx` |
| Apply-run drawers show roadmap placeholder copy instead of persisted timeline events | `apps/api/test/server.test.ts`; `apps/web/src/contexts/apply/components/ApplyRunTimeline.test.tsx` |
| Activity events overload Dashboard or stop being inspectable from the Debug tab | `apps/api/test/server.test.ts`; `apps/web/src/views/dashboard/DashboardView.test.tsx`; `apps/web/src/views/debug/DebugActivityTable.test.tsx`; `apps/web/src/views/debug/DebugView.test.tsx` |
| Job detail audit history misses user-relevant lifecycle entries, duplicates raw event payloads, or exposes debug messages, raw notes, email bodies, or local paths | `apps/api/test/server.test.ts`; `apps/web/src/views/jobs/JobDetailDrawer.test.tsx` |
| Job detail drawer stops opening as an almost full-screen audit workspace, or stops showing top-level ranking rationale, apply readiness, blockers, eligibility concerns, or Apply Review handoff from the shared audit contract | `apps/web/src/views/jobs/JobDetailDrawer.test.tsx`; browser smoke on `/jobs` drawer |
| Requirement-fit explanation regresses by deriving requirement matches from broad score-signal text, hiding the `not_assessed` state for scores without requirement-level evidence, omitting the current-policy re-score path, or letting Apply Review requirement coverage disagree with the projected requirement-fit report | `apps/web/src/contexts/materials/components/EmployerAnalysisPanel.test.tsx`; `apps/web/src/views/jobs/JobDetailDrawer.test.tsx`; `apps/web/src/views/apply-review/ApplyReviewView.test.tsx`; browser smoke on `/jobs` drawer and `/apply-review` |
| Jobs delete/hide lifecycle regresses, causing temporary deletes not to resurface, hidden jobs to leak into active/deleted views, or permanent deletes to leave suppressing tombstones behind | `apps/api/test/server.test.ts`; `workers/automation/tests/test_discovery_identity.py`; `apps/web/src/views/jobs/JobBulkActions.test.tsx`; `apps/web/src/views/jobs/JobsView.test.tsx` |
| Destructive UI workflows touch real user data | `apps/api/test/qa-workflow.test.ts` with `pnpm qa:seed` |
| Source registry compatibility drops discovery config aliases | `workers/automation/tests/test_source_registry.py` covers packaged `sites.yaml` and `employers.yaml` imports, JobSpy `boards` selection, and the `sites` alias warning |
| Posted compensation parsing loses explicit states, over-captures source text, annualizes without assumptions, mutates `jobs.salary`, writes facts from API GET reads, leaks private data, or changes fit score, sorting, filtering, apply readiness, or apply dispatch behavior | `workers/automation/tests/test_posted_compensation_parser.py`; `workers/automation/tests/test_posted_compensation_repository.py`; `workers/automation/tests/test_discovery_identity.py`; `workers/automation/tests/test_discovery_limits.py`; `apps/api/test/posted-compensation-facts.test.ts`; `apps/api/test/server.test.ts` (`compensation boundary`) |
| Deterministic score eligibility fabricates a hard blocker from a brittle heuristic — mis-annualizing hourly/daily/weekly/monthly posted pay into a false below-minimum hard blocker, hard-blocking a remote-vs-onsite work-model preference mismatch, or dropping the blocker/warning source and parsed figure from the audit trail — instead of hard-blocking only a confidently-parsed annual salary from the structured salary field that is below the profile minimum | `workers/automation/tests/test_score_use_cases.py` (`test_constraint_checker_hourly_pay_annualizes_and_does_not_false_block`, `test_constraint_checker_hourly_below_minimum_is_warning_with_annualization_audit`, `test_constraint_checker_confident_annual_below_minimum_is_hard_blocker_with_source`, `test_constraint_checker_monthly_pay_below_minimum_is_warning_not_hard_blocker`, `test_constraint_checker_weekly_pay_annualizes_and_does_not_false_block`, `test_constraint_checker_daily_rate_below_minimum_is_warning_not_hard_blocker`, `test_constraint_checker_bare_amount_without_period_is_still_read_as_annual`, `test_constraint_checker_remote_work_model_mismatch_is_warning_not_hard_blocker`, `test_score_job_keeps_hard_blockers_separate_from_high_score`, `test_score_job_blocks_when_explicit_posted_compensation_is_below_minimum`) |
| Reported company-role compensation estimates fail to emit best-effort ranges from grounded fallback tiers, omit confidence interval bounds for weak evidence, drop the selected source-row evidence or safe source URL behind a range, collapse executive CTO/VP roles into staff/principal/director fallback salary ranges, use bonus-only or one-sided posted salary rows as market evidence, lose Euro Top Tech/Levels.fyi/Glassdoor/manual/source-posted attribution, expose unsafe provider payloads, write rows from API GET reads, skip the CLI, per-job web/API, or all-jobs web/API `compensation-refresh` trigger paths, or change fit score, apply readiness, or apply dispatch behavior | `workers/automation/tests/test_market_compensation_estimator.py`; `workers/automation/tests/test_market_compensation_repository.py`; `workers/automation/tests/test_compensation_refresh_cli.py`; `workers/automation/tests/test_jsonrpc_handlers.py`; `apps/api/test/json-rpc-adapter.test.ts`; `apps/api/test/server.test.ts` (`market compensation boundary`); `apps/web/src/contexts/enrichment/hooks/useRefreshCompensationMutation.test.ts`; `apps/web/src/views/jobs/JobBulkActions.test.tsx` |
| Compensation read-model propagation diverges between Python and TypeScript projection builders, drops raw `JobSummary.salary` compatibility, merges posted facts with market estimates, leaks unsafe compensation data through SSE, or stops invalidating job list/detail after compensation writes | `workers/automation/tests/test_projection_builder.py`; `workers/automation/tests/test_posted_compensation_repository.py`; `workers/automation/tests/test_market_compensation_repository.py`; `apps/api/test/projections.test.ts`; `apps/api/test/server.test.ts` (`compensation boundary`, `market compensation boundary`); `apps/web/src/contexts/operations/every-event-has-handler.test.ts`; `apps/web/src/contexts/operations/invalidation-router.test.ts` |
| Compensation rendering disappears from Jobs table, expanded Jobs detail, or Apply Review; drops the separate Salary min, Salary max, Market, Confidence, or Warnings Jobs columns; stops normalizing posted salary min/max values to EUR/year; moves EUR/year units back into repeated row text instead of compensation headers; hides missing/not-requested states; drops market confidence interval, statistical confidence, source count, sample count, or warning count; merges posted salary and reported market evidence; loses Jobs table sort/filter behavior for any data column; or turns compensation into readiness/apply behavior | `apps/api/test/application-feedback.test.ts`; `apps/web/src/views/jobs/JobsView.test.tsx`; `apps/web/src/views/jobs/JobDetailDrawer.test.tsx`; `apps/web/src/views/apply-review/ApplyReviewView.test.tsx`; browser smoke on `/jobs` and `/apply-review` |
| Source quality stops feeding discovery budgets or dashboard health | `workers/automation/tests/test_discovery_scheduler_pr4.py`; `workers/automation/tests/test_source_quality_projection_pr4.py`; `apps/web/src/views/dashboard/SourceHealthCard.test.tsx`; `apps/web/src/contexts/operations/invalidation-router.test.ts` |
| Discovery product controls stop recording source/quarantine/manual-capture feedback safely, mislabel locator candidates, preview quarantine residue as source leads, or hide low-score role-match suggestions and approval state | `apps/api/test/discovery-controls.test.ts`; `apps/api/test/server.test.ts`; `apps/web/src/contexts/discovery/components/DiscoveryProductControls.test.tsx`; `workers/automation/tests/test_title_filter.py` |
| Apply review queue or outcome tracking starts apply automation, derives readiness differently from job detail, loses local-only outcome notes, hides pending outcome suggestions or in-flight apply stop controls, exposes raw Gmail body text, or stops invalidating job/outcome views after decisions | `apps/api/test/apply-audit.test.ts`; `apps/api/test/application-feedback.test.ts`; `apps/api/test/server.test.ts`; `workers/automation/tests/test_gmail_feedback.py`; `apps/web/src/views/apply-review/ApplyReviewView.test.tsx`; `apps/web/src/contexts/apply/components/ApplicationOutcomes.test.tsx`; `apps/web/src/contexts/apply/hooks/useApplyReviewMutations.test.ts`; `apps/web/src/contexts/operations/hooks/useApplyReviewOutcomeQueries.test.ts` |
| Apply Review stops using the generated HTML/CSS resume as the editable line-level audit surface, falls back to a PDF image overlay for current HTML-rendered artifacts, reintroduces a separate side-by-side line audit pane, loses JobHunter inline comments, loses source-to-tailored claim pins, stops highlighting the selected resume line, hides missing provenance, drops grounding/risk labels from generated claims, loses draft autosave/manual save reload, allows approval while a saved draft is dirty/unrendered/invalid, drops comment replies or source/risk labels, or mutates accepted materials instead of writing a validated replacement generation | `apps/api/test/resume-review-drafts.test.ts`; `apps/api/test/server.test.ts`; `apps/web/src/views/apply-review/ApplyReviewView.test.tsx`; `apps/web/src/contexts/apply/hooks/useApplyReviewMutations.test.ts`; browser smoke on `/apply-review` |
| Resume PDF rendering diverges from the accepted tailored payload, loses `resume_pdf` / render-format tagging, emits unsanitized HTML, drops layout target metadata on the HTML renderer, fails to persist/project layout boxes, stops exposing the generated sibling HTML through `/v1/artifacts/:artifactId/preview.html`, breaks LaTeX-to-HTML resume conversion, or lets LaTeX and HTML renderer helpers consume different text | `workers/automation/tests/test_pdf_renderer_ports.py`; `workers/automation/tests/test_resume_html_migration.py`; `workers/automation/tests/test_materials_repository.py`; `workers/automation/tests/test_dashboard_projection.py`; `apps/api/test/projections.test.ts`; `apps/api/test/application-feedback.test.ts`; `apps/api/test/server.test.ts`; `apps/web/src/views/apply-review/ApplyReviewView.test.tsx`; browser smoke on `/apply-review` |
| Profile baseline resume stops rendering as a Plate HTML/CSS editor, falls back to a PDF iframe, serves `/v1/profile/preview.html` from anything other than the HTML/CSS resume renderer, or reintroduces a Profile-level LaTeX render path | `apps/api/test/server.test.ts`; `apps/web/src/contexts/profile/components/ProfileEditor.test.tsx`; browser smoke on `/profile` |
| Resume template editing persists candidate facts or job facts into template payloads, fails to preserve accepted artifacts during lazy render-only refresh, stops exposing default/per-job template state in Apply Review, or opens stale resume artifacts when a refreshed same-type artifact exists | `apps/api/test/resume-templates.test.ts`; `apps/api/test/application-feedback.test.ts`; `apps/api/test/server.test.ts`; `apps/web/src/contexts/profile/components/ProfileEditor.test.tsx`; `apps/web/src/views/apply-review/ApplyReviewView.test.tsx`; browser smoke on `/preferences`, `/apply-review`, and `/artifacts/$artifactId` |
| Fit-score badges stop using the numeric score as the color source of truth, where 10 is visibly green, 5 is neutral gray, and 0 is visibly red | `apps/web/src/contexts/scoring/components/ScoreBadge.test.tsx`; browser smoke on `/jobs` sorted by fit score |
| Discovery Target search stops driving role guidance, structured track/seniority/function recall, location fallback, Spain/Europe source filtering, new-job discovery limits, or API-visible source controls | `workers/automation/tests/test_target_search_preferences.py`; `workers/automation/tests/test_discovery_limits.py`; `workers/automation/tests/test_discovery_production_wiring.py`; `apps/api/test/discovery-controls.test.ts` |
| Profile, Preferences, Discovery target search, or Settings form autosave/undo regresses and risks losing user edits | `apps/web/src/contexts/profile/forms/profile-form.test.tsx`; `apps/web/src/contexts/profile/forms/settings-form.test.tsx`; `apps/web/src/contexts/profile/components/StructuredProfileEditor.test.tsx` |
| Discovery production wiring stops auto-approving located parseable sources, feeding API-visible manual queues, canonical ATS ingestion, manual-capture imports, snapshot persistence, or acceptance evidence | `workers/automation/tests/test_discovery_production_wiring.py` uses a Barcelona/Spain tech-leadership fixture and report covering lead yield, candidate sources, manual-action count, canonical verification rate, duplicate/quarantine counts, source-quality updates, and scoring handoff count |
| Integrated Discovery preparation stops chaining discovery/enrichment to current-policy scoring, tailoring, and suppression work; loses durable work-item idempotency; exposes internal preparation substages as product stages in the Jobs list; fails to pick up eligible visible pending preparation rows from Jobs; starts skip-only worker runs for known-ineligible pending rows; blocks Apply review on pending cover after a tailored resume exists; fails to self-heal orphaned internal running rows after worker restart; or hides partial preparation failures | `workers/automation/tests/test_discovery_preparation_orchestration.py`; `workers/automation/tests/test_preparation_work_items.py`; `workers/automation/tests/test_pipeline_observability.py`; `workers/automation/tests/test_actions.py`; `workers/automation/tests/test_job_list_projection.py`; `workers/automation/tests/test_orphaned_stage_recovery.py`; `apps/api/test/projections.test.ts`; `apps/api/test/server.test.ts`; `apps/web/src/views/jobs/JobsView.test.tsx`; `apps/web/src/contexts/pipeline/components/StageTriggerPanel.test.tsx`; `apps/web/src/contexts/pipeline/components/UserFacingStageBadge.test.tsx`; `apps/web/src/views/dashboard/Funnel.test.tsx` |
| LinkedIn enrichment misses remain stuck after first-pass failure, enriched LinkedIn rows without application URLs never get a bounded authenticated retry, or the authenticated browser resolver captures LinkedIn/Easy Apply URLs as if they were external company apply targets | `workers/automation/tests/test_linkedin_authenticated_enrichment_retry.py`; `workers/automation/tests/test_linkedin_apply_resolver.py` |
| Scoring policy current-version actions drift from per-job and bulk API/RPC contracts, ignore worker readiness, or fail to expose current-policy work in the UI | `apps/api/test/server.test.ts`; `apps/api/test/json-rpc-adapter.test.ts`; `apps/api/test/rpc-contracts.test.ts`; `workers/automation/tests/test_jsonrpc_handlers.py`; `apps/web/src/contexts/scoring/hooks/useRescoreCurrentPolicyMutation.test.ts`; `apps/web/src/contexts/scoring/components/RescoreCurrentPolicyButton.test.tsx` |
| Manual first-time tailoring or current-policy re-tailoring drift from per-job and bulk API/RPC contracts, drop generator/judge controls, lose low-fit manual override audit events, hide the tailor-stage trigger, or stop suppressing replaced active artifacts when requested | `apps/api/test/server.test.ts`; `apps/api/test/json-rpc-adapter.test.ts`; `apps/api/test/rpc-contracts.test.ts`; `workers/automation/tests/test_jsonrpc_handlers.py`; `workers/automation/tests/test_tailor_retailor.py`; `workers/automation/tests/test_materials_use_cases.py`; `apps/web/src/contexts/materials/hooks/useRetailorCurrentPolicyMutation.test.ts`; `apps/web/src/contexts/materials/components/RetailorCurrentPolicyButton.test.tsx`; `apps/web/src/contexts/pipeline/components/StageTimeline.test.tsx` |
| Threshold lowering or raising stops recomputing tailoring eligibility from persisted scores, invokes the scoring LLM, misses newly eligible tailoring work, or misses now-ineligible artifact suppression | `workers/automation/tests/test_discovery_preparation_orchestration.py`; `workers/automation/tests/test_score_aggregate.py`; `workers/automation/tests/test_materials_repository.py` |
| Artifact suppression leaks suppressed tailored artifacts into active displays or apply readiness, or deletes audit artifact rows/files | `apps/api/test/server.test.ts`; `workers/automation/tests/test_materials_repository.py`; `workers/automation/tests/test_materials_use_cases.py`; `apps/web/src/views/artifacts/ArtifactDetailPanel.test.tsx`; `apps/web/src/contexts/materials/components/ArtifactStatusBadge.test.tsx` |
| Tailoring rationale disappears from Apply review or artifact detail, leaks raw metadata/prompts/profile/resume contents, or breaks PDF preview for tailored resume artifacts | `apps/api/test/server.test.ts`; `apps/web/src/views/apply-review/ApplyReviewView.test.tsx`; `apps/web/src/views/artifacts/ArtifactDetailPanel.test.tsx` |
| The artifact tailoring explanation serves audit data from anything other than canonical projection rows: a read-time TypeScript keyword recompute against the resume file/job description, a sibling artifact's `metadata_json` synthesised onto a shell artifact, or a sibling `.txt` file read from disk; or the derived `keywords` block is non-empty when no canonical coverage was recorded | `apps/api/test/server.test.ts` (`derives the keyword block from the canonical coverage audit row`; `serves an empty keyword block when no canonical coverage exists`; `does not synthesize a PDF artifact's audit from a sibling artifact's metadata`) |
| The TypeScript and Python projection builders drift for the audit tables (`job_employer_analysis`, `job_bullet_provenance`, coverage/voice) — a schema or serialisation difference that lets one runtime project a different read model than the other | `workers/automation/tests/test_audit_projection_parity.py`; `apps/api/test/audit-projection-parity.test.ts` (both driven from the shared fixture `packages/domain-types/test/fixtures/audit_projection_parity.json`) |
| Hybrid retrieval picks stale or weak candidates before LLM scoring | `workers/automation/tests/test_hybrid_search_index.py`; `workers/automation/tests/test_scorer.py::test_run_scoring_preselects_retrieval_top_k_before_llm` |
| Scoring prompt/schema/model/policy changes silently regress parse validity, deterministic policy resolution, cross-job consistency, bands, blockers, ranking, correction agreement, or governance counters | `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_scoring_eval.py workers/automation/tests/test_scoring_eval_feedback.py workers/automation/tests/test_score_repository.py`; update the synthetic scoring fixtures or document why a scoring change does not affect them |
| Score corrections change the policy but leave comparable uncorrected scores fresh, mark corrected versions stale, fail to expose stale policy metadata in jobs list/detail, or fail to clear selected/all stale markers for explicit rescore | `workers/automation/tests/test_score_repository.py`; `apps/api/test/server.test.ts`; `apps/web/src/contexts/scoring/hooks/useResetStaleScoresForRescoreMutation.test.ts`; `apps/web/src/views/jobs/JobsView.test.tsx` |

### Scoring Policy Eval Gate

For scoring prompt, schema, model, rubric, policy, correction-learning, or
stale-score changes, run:

```bash
uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_scoring_eval.py workers/automation/tests/test_scoring_eval_feedback.py workers/automation/tests/test_score_repository.py
```

This gate keeps the local scoring harness focused on non-sensitive facts:
synthetic dimensions, deterministic policy outputs, aggregate anchor/stale
counts, and correction agreement. Do not add raw job URLs, correction
rationales, anchors, resumes, or local paths to eval reports or committed
fixtures.

### Resume Tailoring Quality Eval Gate

For resume tailoring prompt, evidence policy, deterministic quality checks,
judge, or adversarial-review changes, run:

```bash
uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_materials_quality_eval.py workers/automation/tests/test_materials_quality.py workers/automation/tests/test_materials_adversarial.py workers/automation/tests/test_materials_use_cases.py
```

This gate uses synthetic profile and job fixtures only. Do not add real resume
text, raw job URLs, generated artifacts, local artifact paths, or local profile
data to the fixture corpus.

## Frontend QA

The `apps/web` test pyramid follows the strategy defined in
[`docs/frontend-target.md`](frontend-target.md) §10. Run the layers via the
commands listed under the "Frontend" section of
[`docs/local-development.md`](local-development.md).

### Token Foundation QA Gate

For changes to the shadcn token foundation, `apps/web/src/styles/tokens.css`,
`apps/web/src/styles/globals.css`, `components.json`, shared primitive token
classes, theme behavior, or density behavior, run the token foundation proof gate:

```bash
corepack pnpm --filter @jobhunter/web test src/styles/token-contract.test.ts
corepack pnpm web:check
corepack pnpm web:build
corepack pnpm dlx shadcn@latest info -c apps/web
corepack pnpm --filter @jobhunter/web e2e -- tests/token-foundation.spec.ts
git diff --check
```

Also prove generated CSS contains the standard semantic utilities and scan for
retired token aliases before accepting the change. Browser proof must use the
Playwright seeded app directory or another disposable synthetic workspace. Do
not run auto-apply, browser submission, mailbox scanning, real material
generation, destructive profile/database actions, or worker-backed jobs for
token QA.

### Shared Primitive QA Gate

For shared primitive token changes under `apps/web/src/shared/ui`, keep the
QA surface local, synthetic, and primitive-owned. Run the relevant scoped
shared/ui Vitest files plus the changed shared helper tests, for
example:

```bash
corepack pnpm --filter @jobhunter/web test src/shared/ui/data-table.test.tsx src/shared/ui/toast.a11y.test.tsx src/shared/ui/filterable-data-grid.test.tsx src/shared/ui/table-pager.test.tsx src/shared/lib/job-description-blocks.test.ts
corepack pnpm web:check
corepack pnpm web:storybook:build
corepack pnpm web:storybook:test
corepack pnpm dlx shadcn@latest info -c apps/web
git diff --check
```

Also run the retired-token scan and the shared/ui boundary scan. The
retired-token scan must reject `bg-paper`, `text-ink`,
`border-rule`, `ring-info`, retired CSS variables, and bare `text-muted` while
allowing standard shadcn utilities such as `text-muted-foreground`. The
boundary scan must return zero disallowed imports from `shared/ui` into
contexts, views, API clients, routes, TanStack Query hooks, local storage,
EventSource, or clipboard APIs.

The broad `corepack pnpm --filter @jobhunter/web test` command may be skipped
for shared primitive changes when it hits known unrelated inline
snapshot runner failures, provided the scoped shared/ui tests, `web:check`,
Storybook build/test, retired-token scan, boundary scan, and diff hygiene pass
and the skip reason is recorded in the change summary or primitive audit.

Shared primitive QA must use synthetic stories, seeded browser proof, or
disposable fixtures only. Do not run auto-apply, browser submission, mailbox
scanning, real material generation, destructive profile/database actions, or
worker-backed jobs for this gate.

### Route Visual QA Gate

For route-level visual-system changes, run the seeded Playwright route visual QA
spec:

```bash
JOBHUNTER_E2E_APP_DIR=/tmp/jobhunter-route-qa \
JOBHUNTER_E2E_API_PORT=8878 \
JOBHUNTER_E2E_WEB_PORT=5275 \
corepack pnpm --filter @jobhunter/web e2e -- tests/route-visual-qa.spec.ts
```

The spec covers representative routes, overlays, light/dark themes, density
modes, focus indicators, filters, forms, and destructive-control visibility
against disposable seeded data. Keep this gate synthetic or seeded only; do not
run auto-apply, browser submission, mailbox scanning, real material generation,
destructive profile/database actions, or worker-backed jobs for visual QA.

### Coverage layout

| Layer | Files | Purpose |
| --- | --- | --- |
| Unit / hook / component (Vitest + RTL + MSW) | `*.test.ts(x)` files under `apps/web/src/` | Pure selectors, query-key factories, the invalidation router (one registered handler per `DomainEvent` variant in `DOMAIN_EVENT_TYPES`), every Operations read hook, every per-aggregate mutation hook (success path + rollback path), forms, drawers, filter bars. |
| Type-level tests (Vitest `typecheck` mode via `vitest.types.config.ts`) | 10 `*.test-d.ts` files under `apps/web/test/types/` | Inferred shapes of the Operations read hooks plus `useActivityEventQuery` and `useWorkflowRunsListQuery`, using typed test files in Vitest's typecheck runner (cf. target §10.6). |
| End-to-end (Playwright headless) | 11 specs in `apps/web/e2e/tests/` (`dashboard`, `dry-run`, `jobs-bulk`, `jobs-drawer`, `materials`, `profile-edit`, `route-visual-qa`, `runs`, `settings`, `token-foundation`, `wizard`) | One spec per critical flow (target §10.4) against a real `apps/api` + a seeded SQLite fixture. `token-foundation.spec.ts` checks light/dark shadcn tokens, root `color-scheme`, app-shell density values, focus indicators, native select styling, and dense-route rendering without user-affecting automation. `route-visual-qa.spec.ts` checks representative routes, overlays, density modes, focus indicators, forms, filters, destructive-control visibility, and targeted visual snapshots for the requirement-fit job drawer card plus Apply Review requirement card after visual-system changes. `materials.spec.ts` asserts the per-job generate-materials button is enabled, the route returns 202 (not 400), and the worker-confirmed `ResumeApproved` surfaces in the job audit history via the SSE realtime loop. The harness runs the real route + worker-readiness gate (seeded worker heartbeat) but routes dispatch through a deterministic stub (`JOBHUNTER_E2E_STUB_DISPATCH`) so no worker subprocess or LLM is required. E2E ports are overridable via `JOBHUNTER_E2E_API_PORT` / `JOBHUNTER_E2E_WEB_PORT` for parallel worktrees. |
| A11y suites (Vitest + `axe-core` + `jest-axe`) | 11 `*.a11y.test.tsx` files | Form, dialog, drawer, sheet, command, and inspector components (`EmployerAnalysisPanel`, `BulletProvenanceList`) — fails on critical/serious violations (target §10.7). |

### Scoring Policy Feedback Smoke

For UI changes around score correction learning, verify the jobs table shows
the compact stale-score badge on unresolved stale scores, the job drawer shows
the policy update state, and the reset control posts to
`/v1/scoring/stale-scores/actions/reset-for-rescore` before running
`jobhunter run score --rescore` or the score stage with `rescore: true`.

### Jobs Drawer Audit Smoke

For UI changes around job ranking or readiness, open `/jobs`, click a job row,
and verify the drawer top section shows why the job ranked where it did
(score, band/confidence, reasoning, signals, keywords), whether it is ready for
apply review, any missing prerequisites, hard blockers, eligibility concerns,
and an Apply Review handoff. The readiness and blocker copy must come from the
shared `applyAudit` contract. The drawer should use almost the full viewport on
desktop and arrange detailed sections in a wide audit workspace rather than a
narrow side panel. When touching score visuals, sort by fit score and verify
score badges use the numeric color contract: 10 green, 5 gray, and 0 red.
When touching requirement-fit explanation, verify scored jobs show requirement
fit as the explanation of the numeric score and jobs without
`requirementFitReport` show "not assessed" plus a current-policy re-score action;
the drawer must not derive requirement matches from broad matched/missing signal
text.
When touching compensation rendering, verify the Jobs table shows separate
Salary min, Salary max, Market, Confidence, and Warnings columns, that salary
min/max/market values are normalized to EUR/year with the unit carried by the
headers, that every data column can request a sort, and that
the drawer Compensation section separates posted salary from
reported company-role market evidence, source trail, source/sample counts,
source-conflict warning code/message, warnings, confidence factors, collapsed
selected evidence rows, evidence source links when available, and the market
confidence interval. The
drawer refresh control must re-run only the selected job's compensation
analysis, the Jobs toolbar `refresh compensation` action must re-run
compensation analysis for all jobs, and both refresh paths must honor configured
reported-source loading plus the optional reported-observations JSON path
without running
discovery, scoring, tailoring, cover, apply automation, mailbox scanning, or
material regeneration.
Do not run apply submission, mailbox scanning,
material regeneration, destructive profile/database actions, or worker-backed
jobs for this smoke.

### Apply Review Smoke

For UI/API changes around application review or outcome tracking, open
`/apply-review` and verify the queue shows ready and blocked apply-stage jobs,
derives the visible status tag/counts from `applyAudit`, offers submit approval
only after a completed dry run, records `approve_submit`, dry-run approval,
defer, decline, and reset decisions without starting apply/browser automation,
and refreshes the queue after each decision. Open a job detail drawer and
verify its `applyAudit` readiness/blocker facts agree with the selected Apply
Review job. Verify the selected review also shows compensation range and
statistical confidence from `compensationSummary` without changing readiness,
queue inclusion, or approval controls. For resume-audit changes, verify the
tailored resume renders as a Plate-backed HTML/CSS editor, not a PDF image
overlay; the first render matches the final artifact's generated HTML/CSS and
keeps the LaTeX-style resume content layout (A4 page, centered header, black
section rules, compact entry grids, and real list bullets); the "open final
file" link still opens the generated PDF artifact; and line-level JobHunter
comments appear on the resume surface rather than in a separate side-by-side
audit pane. Selecting a resume line must highlight that editor line and keep a
single JobHunter comment open beside it; comments expose source text, rationale,
source precision, grounding/risk labels when provenance exists, and missing
provenance as an explicit state instead of blank space. When requirement-led
audit metadata exists, verify Apply Review can show covered and uncovered
requirements, evidence-backed generated claims, pinned content, adjacent or
draft labels, bullet-limit overflow reasons, revision decisions, and review
blockers, and that raw prompts, full profile/job text, local paths, generated
PDFs, logs, browser data, and SQLite contents are absent from the response.
Edit a generated claim line and a structural line, verify autosave/manual save
reload the draft, reply to a JobHunter comment while keeping the source pointer
and risk label visible, verify approval buttons stay blocked until the saved
draft validates/renders, then render a replacement and confirm the final-file
link points at the latest approved artifact while the existing accepted artifact
was not deleted. Manual
outcomes should save with a
canonical timestamp, local notes render only in the outcome timeline, pending
outcome suggestions can be accepted, corrected, or ignored, and the job audit
history shows review/outcome entries without raw notes, email body text,
debug statements, or raw event names.

For Gmail feedback changes, use fake Gmail clients or seeded worker fixtures.
Do not scan a real mailbox for QA automation. Verify that the scan is bounded
by application anchors, recipient, max result/window limits, and employer/ATS
hints; that `read_email` is not called for unlinked metadata; and that the API
scan response includes only counts plus evidence/suggestion identifiers, kinds,
and confidence values.

### Materials Generation + Inspector Smoke

For UI/API changes around per-job material generation or the tailoring inspector,
open a job detail drawer and verify the "generate materials"
control is enabled, confirms before dispatching, and reports a queued/in-flight
state; the route is `POST /v1/jobs/:jobKey/actions/generate-materials` and returns
202 once the worker is ready (503 when the worker heartbeat is missing/stale). Do
not run real generation against a live worker for QA automation — exercise the
route + UI wiring with the E2E stub dispatcher and inject the terminal
`ResumeApproved` event into SQLite to drive the realtime loop.

Verify the inspector renders honestly: the employer-analysis panel shows
requirements (must/nice tier + priority weight) and reasoned keywords with quoted
job-description evidence spans; the per-bullet provenance list shows the
original → tailored diff and evidence × requirement × transform × control ×
rationale per bullet. Confirm missing audit data is never masked — a job with no
analysis shows an explicit "not recorded" state, empty FK/keyword sets show "none
recorded", a drafted-adjacent bullet shows an explicit "original profile bullet
not recorded" diff side, and a null voice pass shows "no voice pass recorded".
Confirm a re-tailor/generate-materials in flight never hides the last accepted
artifact or its provenance.

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

10 stories defer the a11y check (`a11y: { test: "off" }`) because they exercise
production a11y defects that are tracked outside the story. Each deferral is
recorded in [`docs/backlog.md`](backlog.md) "Frontend Accessibility Backlog"
with the affected production file and the defect type.

### Storybook gate

`pnpm web:storybook:build` produces the static Storybook bundle;
`pnpm web:storybook:test` serves it with `http-server` and runs
`test-storybook` over every story. A story that throws on render, fails its
`play()` interaction, or surfaces a critical / serious axe violation fails
the gate.
