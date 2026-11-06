# Python transformation capability reconciliation

Adversarial capability reconciliation for [#1428](https://github.com/ebarti/JobCtrl/issues/1428).
Baseline: `9f6f318a86f103f6fdfd0c4aab41d7d26917b2e7`. The baseline was inspected
with `git show`; no old checkout or private workspace was opened. This record is
owned by the capability auditor. Production files are read-only to that owner.

The accepted [transformation](2026-11-06-python-transformation.md) preserves every
current capability except Cover Letters, preserves the full Profile and its
sources at cutover, starts other data fresh, and requires one Python authority.
An old URL need not survive when an equivalent reachable product path replaces
it. A generic CLI `request` or `action` command, an unused service, a declaration,
or a directory rename is not by itself parity evidence.

## Evidence state

This record includes the current frozen owner handoffs and the coordinator's
latest acceptance readback. The initial inventory was taken during construction;
its former missing adapters and legacy-retirement blockers must not be treated
as current defects when the dispositions below close them. Source completion,
focused public-journey success and complete-candidate acceptance are distinct.
**Overall acceptance remains open:** the current 21-journey source/web run
(`rCUXK8`) had reported six failures at the latest coordinator readback, with
repairs assigned. No GitHub completion, merge or release is established here.

- `OPEN`: capability/evidence still requires reconciliation.
- `IN PROGRESS`: owning implementation exists; final integrated acceptance is
  still pending. It does not mean the old missing implementation remains absent.
- `SOURCE COMPLETE`: current source and static checks close the stated boundary.
- `FOCUSED PASS`: named focused public journeys passed; wider acceptance remains
  separate and any platform/payload qualification still applies.
- `REPAIR`: source-backed regression in the currently written replacement.
- `FAILING`: the current integrated run has observed failures under repair.
- `VERIFIED`: reserved for an observed integrated public journey on the final
  candidate; no row currently has this status.
- `SUPERSEDED`: deliberately retired by an accepted product/architecture decision,
  with the retained user value and new authority recorded explicitly below.
- P0 prevents an honest cutover; P1 prevents feature acceptance; P2 is a retained
  usability/operations obligation. Priority is not a claim that unfinished work
  has already been delivered incorrectly.

The latest evidence disposition is:

| Boundary | Current result | Remaining qualification |
| --- | --- | --- |
| Legacy backend authority | Production source files in old Fastify, Python workflow/business roots, infrastructure, domain and global config/database/LLM roots are physically deleted. The earlier transitive closure was clear; the coordinator reports the current whole static check passed. | Final complete source/web run remains open. No temporary runtime bridge is retained. |
| CLI setup and onboarding | Current `cli.py:init/setup/doctor/backup` contains owner-flow onboarding, hidden native credential entry, explicit Codex enrollment, dry-run/noninteractive/JSON controls, live catalog/readiness, revision-fenced settings and source backup. Coordinator reports shared-stack CLI E2E passed. | The full shared run is not passing yet; the separate Digest CLI behavior below remains unresolved. |
| Native lifecycle and process custody | Frozen native lifecycle partition passed in **47.659 seconds** (eight cases); custody passed in **61.296 seconds** (seven cases), with cleanup and independent no-listener readback. | These use real compiled binaries and an owned unsigned synthetic payload. Signed/notarized published-predecessor qualification and the remaining platform matrix are distinct release gates. |
| Full source/web acceptance | Current 21-journey run has observed failures; doctor policy-snapshot handling, Plate ID mapping, selectors and header/deadlock failures have assigned repairs. | Repair, rerun and bind the complete result to the final candidate before claiming overall success. |
| Offline demo | Final composed demo acceptance remains pending. | Prove browser-local lifecycle and truthful external unavailability without live API/credential/provider fallback. |

Native results were read from
`/private/tmp/jobctrl-transform-1428/native-lifecycle/native-final-candidate.json`
and `native-partitions-proof.json`, including the respective
`jobctrl-native-lifecycle-WBuAOA/result.json` and
`jobctrl-native-lifecycle-GMT76m/result.json`. The candidate record contains
source and binary hashes. It also records limited post-run harness bookkeeping
adjustments; the required partition inputs and assertions are reported
equivalent, rather than claiming every final harness byte ran unchanged.

## Capability ledger

All baseline source references below mean the file at `9f6f318`; current target
paths are beneath `workers/automation/src/jobctrl/` unless stated otherwise.

| Priority / state | Retained capability and exact baseline entry | New owner / current implementation | Required reachable replacement and missing evidence |
| --- | --- | --- | --- |
| P0 · SOURCE COMPLETE | One local authority: `apps/api/src/server.ts`; `cli.py`; old RPC/Temporal worker | Foundation: `app/`; Runtime: new `cli.py`, `launcher/internal/launcher/python_application.go` | Legacy authority roots are deleted; conservative imports were clear and the coordinator reports whole static checks passed. Native partitions exercised real Python API/worker/Temporal and canonical CLI. Complete source/web acceptance remains open. |
| P0 · IN PROGRESS | Profile facts/preferences/attestations/style/template: `GET/PATCH /v1/profile` (`server.ts:3111,3180`), `infrastructure/profile/` | Profile: `features/profile/{models,repository,service}.py` | Browser save/reload and CLI read/write; exact expected-version conflicts; all authored baseline roles/achievements, attachments, confirmations and provenance survive one-off synthetic transfer. Preserve uncertain authority. |
| P0 · OPEN | Full Profile cutover including retained originals and review decisions: `legacy_evidence_cli.py`; old profile tables/files | Profile transfer + Runtime `profile-transfer --source --target --confirm-profile-only-reset` | Read-only source export; fresh target contains only Profile; every retained file and source/decision identity reconciled; non-profile state empty; failed transfer never reports success. Run outside recurring E2E. |
| P1 · IN PROGRESS | PDF resume import preview/confirmation: `POST /v1/profile/import-resume` (`server.ts:3463`); `/profile/import/{upload,preview,confirm}` | Profile `service.py:import_resume/accept_import`; core web Profile | Real PDF extraction boundary, review/confirmation and source retention. Invalid model output or stale acceptance preserves prior Profile. |
| P1 · IN PROGRESS | Profile required-bullet coaching and target-role suggestions: `/v1/profile/required-bullet-suggestions`, `/target-role-suggestions` (`server.ts:3250,3376`) | Profile `coach_required_bullets`, `suggest_target_roles`; core web Profile | Opposing controlled model decisions, exact saved source/version bindings, user acceptance and rejection, failed refresh preserving reviewed output, autosave/accept conflict handling. |
| P1 · IN PROGRESS | Legacy evidence list/recover/decide: `legacy_evidence_cli.py:31,37,64` | Profile `/v1/profile/legacy-evidence` read/recover/decision routes + Runtime `legacy-evidence` | Reachable owner methods and dedicated CLI now exist. Final evidence must reconcile original/current cells, conflicts, retained uncertainty and exact current-state review fences through the transferred source inventory. |
| P1 · IN PROGRESS | Manual Jobs, URL import, source snapshots, refresh: `/v1/jobs`, `/v1/jobs/import-url`, job detail; direct CLI `job` | Jobs `features/jobs/{bootstrap,service,repository}.py` | Actual UI capture/refresh/read, duplicate/racing capture, authoritative application URL, import progress and honest acquisition failures. Jobs must function when Discovery and Companies are omitted. |
| P1 · IN PROGRESS | Posting availability: `endpoint-spec.ts:checkPostingAvailability`; CLI `check-availability` | Jobs acquisition/page interpretation | A named reachable availability check with source/version provenance and `available/unavailable/unknown`; a general refresh needs equivalent visible output and semantics. |
| P1 · IN PROGRESS | Reviewed permanent deletion, hide/restore, bulk selection: `/v1/jobs/permanent-delete-selection`, `/bulk-delete-permanent` (`server.ts:1968,1974`) | Jobs `bootstrap.py:delete_selection/bulk/visibility`; owned repository and public deletion callbacks | The original raw-ID defect is repaired: current deletion requires an expiring reviewed selection and exact job/state revisions. Owner cleanup uses same-transaction public callbacks; Resumes reports rollback, foreign-file refusal and idempotent retry controls. Complete product selection/concurrency/cleanup acceptance remains open. |
| P1 · IN PROGRESS | Bulk failed-stage retry and pending preparation: `/bulk-retry-failed`, `/bulk-run-pending-preparation`; per-job retry/run/cancel (`server.ts:2006,2074,2355,2436,2760`) | Jobs UI + `app/preparation*` + CLI recipe/retry commands | Current `preparation.run/retry` actions retain selected/pending scope and per-stage outcomes; CLI submits those actions. Final UI/worker evidence must cover bulk selection, individual failures, cancellation/restart and accepted-artifact preservation. |
| P1 · IN PROGRESS | Discovery providers, targets, settings, schedules, search controls: `/v1/discovery/settings`, `/sources`, `/sources/:id/state`; CLI `discover/run` | Discovery `features/discovery/`; Jobs ingestion public port | All currently supported provider families including JobStreaming, literal filters, result limits, pause/cancel/restart, per-source policy and schedule changes. Observe controlled external search through real worker and canonical ingestion. |
| P1 · IN PROGRESS | Discovery source preview, proposals, locator promote/reject/reset: `server.ts:1351,1359,1363,1388`; `source_proposals_cli.py:46,56,64` | Discovery `bootstrap.py` source-proposals/from-history and locator decision routes + Runtime dedicated CLI | The proposal lifecycle is implemented. Final acceptance must retain opt-in generation, origin receipts, rejection/disabled intent and explicit suppression reset. |
| P1 · IN PROGRESS | Manual capture queue/recovery and quarantine: `/v1/discovery/manual-capture/:id/{prepare,import,supersede,dismiss}`, `/quarantine/:key/decision` | Discovery manual-capture prepare/import/supersede/dismiss routes; Jobs-owned quarantine through public ports | Current queue/review routes are present; final transport evidence must establish exact review lifetime, provenance, retry/ack idempotency and restart behavior. |
| P1 · IN PROGRESS | Discovery feedback and role-match suggestions: `/v1/discovery/feedback`, `/role-match-feedback/:id/decision` | Discovery `bootstrap.py` feedback/refresh/decision routes + public model/source inputs | Equivalent named paths are implemented. Final evidence must show reviewed source-bound determinations and explicit literal filter changes, without lexical meaning or silent settings edits. |
| P1 · IN PROGRESS | Company briefing configure/show/refresh: `company_briefing_cli.py:69,92,98`; job/interview/digest reads | Companies `features/companies/` | Source-bound public research, explicit identity links, bounded refresh and failure preservation; Companies removed independently leaves manual Jobs and core usable. |
| P1 · IN PROGRESS | Requirement extraction, occurrences, qualified meaning and corrections: former score/posting readers | Requirements `features/requirements/{service,repository,http}.py` | Persist source spans/receipts; reuse paraphrases without collapsing qualifications; retrieval miss never proves novelty; concurrent discovery, stale source and corrections through actual API. |
| P1 · IN PROGRESS | Person qualification, eligibility, scoring/corrections and evidence map: `/v1/jobs/:key/score-correction`, `/v1/scoring/*`, `/v1/evidence-map` | Fit `features/fit/`; public Profile/Requirements snapshots | Separate factual fit from wording coverage; preserve corrections, provenance, policies/visible score semantics and stale refresh. Actual integrated read path must consume recorded IDs. |
| P1 · IN PROGRESS | Reusable approved wording with explicit decisions and suppression | Profile wording library + Fit authoring port | Approve/reject/defer real proposals; exact source/version fences; unchanged or rejected/deferred origins do not repeatedly spend/regenerate; no automatic approval by Fit or Resumes. |
| P0 · IN PROGRESS | Full-baseline resume composition and baseline-copy/off: old Tailor + #1426 accepted behavior | Resumes `features/resumes/{domain,service}.py` | Exact component composition and explicit resource refusal are implemented; owner actual-API proofs cover sparse/dense cases, exact IDs, no ready-compose model calls and preservation of accepted PDF bytes. Final product evidence must still bind every authored role/achievement/fixed field and editor acceptance to the final candidate. |
| P1 · IN PROGRESS | Editable resume drafts, revisions, comments, rendering and manual acceptance: `server.ts:1823–1941`; `endpoint-spec.ts:renderResumeReviewDraft` | Resumes service `edit/approve_edits/review/render/accept/comment`; core web Plate surfaces | Drive real editor; approved edits must become Profile-owned wording without losing the document/role inventory. Keep accepted artifact during failed render/model/recompose. Advisory finding/timeout override records the true review status separately from acceptance. |
| P1 · IN PROGRESS | Resume template library/default/per-job assignment/current-material refresh: `server.ts:1769–1810` | Resumes repository templates + web materials | Preserve custom template edit/save/default/per-job selection and actual rendering, not only a stored opaque template record. Verify all current Profile/job/artifact Plate export surfaces. |
| P1 · IN PROGRESS | PDF/HTML preview, DOCX export and OS opening: `/v1/artifacts/:id/{download.docx,preview.pdf,preview.html,open}`, Profile previews (`server.ts:2942–3147`) | Resumes renderer + runtime/browser download/open adapters | Actual file bytes, correct accepted revision, selectable/exported contents and full baseline; blocked path traversal; failures leave last accepted bytes. Profile preview remains reachable. |
| P1 · IN PROGRESS | Locale translation/review/accepted exports: `endpoint-spec.ts:materialLocaleVariants/acceptedMaterialExports`; CLI `material-locale/material-export` | Resumes locale owner + Runtime named CLI commands | Named translation/export paths are present. Final acceptance must preserve source-linked independent locale revision/review/acceptance and accepted PDF/DOCX bytes; baseline copy and locale model use remain truthfully separated. |
| P1 · IN PROGRESS | Reviewed material feedback and authored preferences: `server.ts:1857`; old material-feedback readers and Profile preferences | Resumes feedback + Profile | Retain reviewed feedback/history and user-owned preferences. Do not silently equate these with career milestones. Adaptive rules that only tune writing/omission/personas/repair are explicitly superseded by #1255; factual grounding is now invariant, not a learned policy option. See the accepted retirement record below. |
| P1 · IN PROGRESS | Screening-answer library, proposals/review/history, application-bound answers: `endpoint-spec.ts:screeningAnswers/writeScreeningAnswer`; CLI `screening read/write` | Applications `features/applications/screening.py` | Current typed forms, review, reusable answers, prior bindings/history, semantic provenance and stale-source rejection; never infer protected attestations or submit from library edits. |
| P0 · IN PROGRESS | Apply payload review, exact approvals, repeat checks/override, manual browser boundary and approved email execution: `/v1/apply/review-queue`, per-job apply-review/repeat/apply; CLI `apply` | Applications + Resumes accepted public snapshot + browser/mail adapters | Baseline live browser submission was already refused before browser/agent launch. Preserve manual final submit, reviewed extension autofill, exact email payload/source/attachment revalidation, at-most-once intent/receipt, cancellation/restart and ambiguous outcome handling; no Cover fields. See source-backed decision below. |
| P1 · IN PROGRESS | Read-only browser inspection and typed findings: `apply/prompt.py:72`; `domain/apply/terminal_report.py:36`; `domain/apply/process_manager.py:511` | Applications `browser.py`, `inspection.py` and rehearsal service | The initial inspection gap is repaired: current actual page observations feed source-cited ready/expired/CAPTCHA/login/email-only/manual/failed/uncertain determinations. Email candidates require literal observed destination plus accepted-resume citations and a new payload/approval. Final composed proof remains separate; browser execution still requires manual submission. |
| P1 · IN PROGRESS | Finite/continuous Apply batches and settings-controlled standing loop: `cli.py:1590,2429,2578`; `apply/auto_apply.py:63`; `apply/workflow.py:168` | Applications `batch/run_approved` + Foundation recurring runtime + CLI/pipeline adapter | Owner reports bounded batch and approved polling actions implemented. Still prove recurring registration, enable/disable, current approvals, score/capability/budget policy, skipped/refused job semantics, stable item identities, stop/restart and no duplicate email send. `run all` must not gain an implicit Apply stage. |
| P1 · IN PROGRESS | Manual outcomes, outcome suggestions, Gmail scan/auth: `/v1/jobs/:key/outcomes`, `/v1/outcome-suggestions/:id/decision`, `/v1/outcomes/gmail/scan`; CLI `gmail-auth` | Applications mail/outcome owner + Runtime native auth | Controlled mailbox capture/provenance, user review and correction, outcome history/analytics; actual auth readiness/status path retained. No live communications or real mailbox in QA. |
| P1 · IN PROGRESS | Contacts CRUD/import/provenance/research/candidate confirmation: `server.ts:3804–4025` | Contacts `features/contacts/` | Actual import, source policy, research/correction/confirmation, optimistic conflict and cancellation; Contacts works without Outreach. |
| P1 · IN PROGRESS | Outreach draft/thread review, send logging, follow-ups: `server.ts:4027–4260` | Outreach `features/outreach/` | Reviewed draft/edit/approve/copy/send-log lifecycle, stale source rejection and follow-up schedule/complete/dismiss/due. Baseline does not itself send messages; preserve that explicit manual-send boundary. |
| P1 · IN PROGRESS | Interview research catalog/guidance, prep/history, notes and session context: `endpoint-spec.ts:interview*`; per-job generate-interview-prep | Interviews `features/interviews/` | Question-scoped selected evidence, independent notes/history and failed replacement preservation; actual catalog/UI reachable without provider; optional Companies/Applications remain optional. |
| P1 · IN PROGRESS | Career evidence comparison, aspirations/plans/milestones: `endpoint-spec.ts:careerLearning/writeCareerLearning` | Learning `features/learning/` | Real source-bound comparison and stale update checks; milestone activity never writes Profile facts or increases Fit; remove Learning independently. |
| P1 · REPAIR | Digest creation/read/acknowledgement and score threshold: `GET /v1/digest`, `POST /v1/digest/acknowledge`; CLI `digest` (`cli.py:1866`) | Digest public-summary composition and acknowledgement repository; Runtime `cli.py:digest` | Current API/service are implemented, but baseline CLI `--min-fit-score` supplied a one-read threshold override; the target CLI omits it. Baseline `--acknowledge` returned the generated digest and acknowledged its `generatedAt`; target currently returns only the acknowledgement POST result. This narrow retained behavior is sent to the coordinator/Runtime for reconciliation. No external delivery capability is inferred. |
| P1 · IN PROGRESS | Posted/market compensation, provider policy, refresh: `/v1/compensation/sources`, `/v1/jobs/:key/compensation/*`, refresh endpoints; CLI `compensation-refresh` | Compensation neutral `core/` plus adapters; composed Jobs grid/filters and feature panels | The formerly missing Jobs compensation columns/filters are present in `ComposedJobsGrid.tsx` and `AdvancedJobFilters.tsx`; current backend includes direct benchmark and geographic lineage validation. Final product acceptance must cover visible sorting/filtering, refresh mounts, provenance/date/currency/unknown semantics and owner independence. |
| P1 · IN PROGRESS | Actual offer terms/scenarios/history/corrections/decisions: `apps/api/src/offer-routes.ts` | Offers `features/offers/{service,http}.py` | Unset terms stay unknown; concurrent expected-ID conflicts, corrected acceptance/rejection history, no unintended application stage mutation; draft sources bind exact offer revision. |
| P1 · OPEN | Dashboard, analytics, evidence map, activity details, pipelines, runs: `server.ts:1000–1257,2891`; `apps/web/src/routes/` | Web shell composition + feature public panels/queries; Foundation action runs/events | Preserve retained reads and controls. No hardcoded empty list or generic health payload presented as equivalent analytics/operations. One SSE connection, committed events and feature-owned invalidation. |
| P1 · IN PROGRESS | Settings, provider model inventory/verify, credentials/batch/delete, browser capability enable/disable/profile-copy: `server.ts:3500–3770`; `endpoint-spec.ts:provider*` | Foundation Settings/credentials/model providers + runtime native capabilities | Every visible control writes the value consumed by the correct new owner; preserve native store/readiness, endpoint selection, lane/spend policy and no secrets in responses/events. |
| P1 · FOCUSED PASS | CLI setup/init/doctor/backup/run inspection/retry: old `cli.py:1003,1017,2180,3271,3404` | Runtime new `cli.py`, `runtime_commands.py`, native launcher | Setup/onboarding, detailed doctor and source backup are implemented; coordinator reports the shared-stack CLI journey passed. Native partitions prove coherent paired backup/restart and owned-process behavior. Full-run doctor integration repairs remain under the current failing suite; the separate Digest CLI row is not covered by this success. |
| P0 · IN PROGRESS | Extension token/auth, capture/ack, discovery claim/task/lease/result/cancel, typed autofill/map: `server.ts:658–949`; `apps/extension/src/local-api.ts` | Runtime extension transport + Foundation auth + Jobs/Discovery/Applications | Browser extension actually reaches sole Python port with pair/rotate/revoke, exact capture acknowledgement, lease expiry/cancel/restart and safe fill-only mapping. Do not retain old server solely for extension parity. |
| P1 · IN PROGRESS | Public offline demo workspace, synthetic edits/history/consent/events/reset/export: `apps/web/src/demo/{portFactory,capabilities,DemoApiClientAdapter}.ts` | Demo owner + web feature transports | Retain explicitly browser-local capabilities and truthful unavailable/rehearsed external behavior; no live local API/credentials/provider fallback. New feature HTTP adapters must be supported by demo composition. |
| P0 · FOCUSED PASS | Installed/source startup, stop/restart, provider/browser packs, backups/rollback/update, static assets and renderer | Runtime `launcher/`, `scripts/dev`, `packaging/distribution/` | Native lifecycle/custody partitions passed on frozen source/binaries in 47.659/61.296 seconds, with real Python/worker/Temporal, paired backup/update/rollback, legacy refusal and unrelated-process preservation. Current complete source/web evidence and separate signed/platform release qualifications remain open. No release/deployment is implied. |
| P0 · FAILING | E2E-only fresh target suite and real product coverage | E2E `apps/web/e2e/harness/`, `scripts/run-e2e.mjs`, `docs/developer/qa/python-journeys.md` | Current 21-journey source/web run `rCUXK8` has observed failures, with repairs assigned; no complete pass is claimed. Every retained row still needs final-candidate journey or explicit one-off evidence, including setup-inclusive timings. Controlled external boundaries only; no internal mocks, canned success or replay corpus. |

## Architectural audit gates

1. **Composition and reachability:** final feature registrations must be explicit.
   A feature-owned HTTP adapter and service must be reached from the actual web,
   CLI and durable action paths. Search installed manifests and scripts as well
   as imports before declaring the old authority gone.
2. **Private data:** feature code may query its own tables; readers of other
   owners use public immutable snapshots and version fences. The initial schema
   ownership/SQL-name scan found no literal cross-feature private-table access
   in the target packages. This does not cover dynamic SQL or old repositories
   reached indirectly and is not final architectural approval.
3. **Independence:** remove each optional registration and boot/use core. Verify
   Jobs without Discovery/Companies, Contacts without Outreach, Profile without
   Requirements/Fit, and the Compensation core without JobCtrl runtime.
4. **Atomic authority:** source snapshot checks and accepted writes must share
   the final canonical transaction. An earlier read/check followed by an
   unrelated write can accept stale meaning, approval or source bindings.
5. **External effects:** retries cannot create fresh authorization. Distinguish
   not-started, durable intent, confirmed receipt and unknown outcome after a
   crash; cancellation cannot erase an already committed effect.
6. **Profile/editor integrity:** compare the complete authored role/achievement
   inventory and supporting source bytes/IDs before and after transfer and
   rendering. Style or editor changes cannot silently discard content, invent
   approval, or replace saved evidence with inferred authority.
7. **Proof quality:** unit-level imports/compilation prove syntax only. A green
   E2E route that returns an empty list or echoes an input is not retained
   behavior. Require observed canonical write/read, visible product behavior and
   failure preservation for each claimed capability.

## Resolved Apply parity question

Decision from the actual baseline call graph: the target's browser
`manual_required` result preserves the existing final-submit boundary. The
baseline does **not** automate live browser form filling or final submission
after approval. Adding a trusted final-form mediator now would expand the parked
Applications scope.

| Baseline evidence | Observed executable behavior |
| --- | --- |
| `cli.py:1590` → `workflow_specs.py:266` → `apply/workflow.py:168` → `apply/activities.py:123` → `apply/launcher.py:3699` | The real CLI Apply path starts the durable workflow, executes the launcher, and calls its canonical use case; this is not a dormant class. |
| `apply/launcher.py:3261,3762` | `_build_use_case` constructs `SubmitApplicationUseCase` with the real Chrome/Claude/Gmail adapters; `run_job` executes it after availability checks. |
| `domain/apply/use_cases.py:270` | A non-dry-run without an approved email candidate records `ApplySubmissionBlocked`, completes with `Manual("trusted_final_submit_required")`, and returns **before** prompt construction/browser launch/agent execution. |
| `domain/apply/process_manager.py:233,401`; `infrastructure/apply/claude_code_cli.py:344` | The saga independently refuses unlocked live browser configuration; an agent-reported `Applied` is rejected. The Claude adapter also refuses `dry_run=False` before creating runtime files/subprocesses. |
| `apply/prompt.py:77`; `infrastructure/apply/claude_code_cli.py:73` | The inspection prompt forbids typing, credentials, screening answers, uploads and final Submit. The active tool exclusions remove fill/type/select/upload/evaluate authority. |
| `apps/extension/src/content-script.ts:140,221` | The separate extension **does** fill explicitly selected fields after a trusted user click, using exact form/profile mapping. It excludes submit/file/password controls and does not submit the employer form. This remains a retained capability. |
| `apply/chrome.py:693,794,1444`; `domain/apply/terminal_report.py:36` | Read-only inspection has one exact approved GET grant; blocked channels determine honest coverage. Model terminal results classify observed expired/CAPTCHA/login/email-only/manual/failed states with source citations. A fake `applied` report is refused. |
| `domain/apply/process_manager.py:511,605,706`; `apply/launcher.py:3008,3061` | Email-only observation becomes a reviewable candidate. The owned sender revalidates the exact reviewed recipient/subject/body/attachment plus current Profile/material/source binding, pins attachment bytes, commits a durable intent, then sends. Post-intent error is an ambiguous non-retryable outcome. |
| `infrastructure/apply/email_sender.py:15` | The real Gmail adapter calls `GmailClient.send_email_application` and binds its validated confirmation to the admitted operation. Email sending is implemented, not merely an advertised future path. |

The smallest retained target contract is therefore:

1. Keep browser final submission manual, with the separate reviewed extension
   fill path and no general browser-agent write/upload authority.
2. Keep an honest read-only browser rehearsal, its source-bound typed findings
   and a reviewable email candidate. Capturing the safe page observations and
   asking the target model gateway for one persisted determination can satisfy
   this without restoring the old autonomous agent or a second backend.
3. Keep exact-approved email execution under one final source/attachment/stop
   fence, durable intent, matching confirmation and unresolved-outcome guard.
4. Keep per-job, finite batch, continuous and settings-controlled polling as
   orchestration of those same actions. Polling does not authorize a new payload
   or turn a browser result into a submission.

Baseline admission distinguishes **eligibility/currentness** from the numeric
selection threshold. Targeted worker selection requires a current eligible
canonical score, accepted rendered resume, not-closed posting and Apply controls,
but does not compare the score to `min_score` (`apply/launcher.py:698`). Automatic
selection also requires the minimum score, excludes quarantined/literally blocked
sources, and orders by score descending then URL (`apply/launcher.py:714`). The
final owned-email source reader repeats the targeted selector under its writer
fence (`apply/launcher.py:769`), so exact approval alone never proves current
eligibility. The target can preserve this through a public Fit snapshot/fence;
missing Fit must not silently become eligible. External manual submission and
manual outcome recording are separate user actions.

There is one baseline CLI inconsistency to disclose rather than infer away:
`apply --url` runs `count_ready_to_apply` first, and that count still applies the
numeric threshold (`database.py:3391`), while the per-job API and
`job <saved URL> --apply` reach the targeted selector without that preflight.
The smallest coherent target preserves threshold selection for automatic work
and current eligible Fit for explicit approved execution; it need not recreate
the old count's substring-URL matching behavior. The coordinator and owners have
been informed of this distinction.

The current target `features/applications/browser.py:inspect` only performs one
GET and returns partial coverage/check labels; it does not retain observed page
content or classify the baseline terminal states. That is the concrete remaining
inspection gap, rather than a missing automated browser-submit capability.
Applications reports `applications.batch` and `applications.run_approved` added;
those declarations still need integrated recurring-runtime and E2E proof.

### Current CLI/pipeline versus parked expansion

- `jobctrl apply` is implemented with finite ready-job batching, limit, workers,
  minimum score, explicit URL, dry-run, headless/model and continuous options
  (`cli.py:1590–1764`). Utility mark-applied/mark-failed/reset-failed and
  stopped-custody recovery modes also exist. The ordinary default is all
  **currently** ready jobs, not a forever loop.
- The standing loop is active code: worker startup and heartbeat invoke
  `reconcile_auto_apply_loop` (`cli.py:2429,2578`). The reconciler starts/cancels a
  deterministic workflow according to settings, capability and budget
  (`apply/auto_apply.py:63`). Continuous workflow iterations use bounded batches
  of 25, current settings and dispatch frontier; live activity retry count is
  one (`apply/workflow.py:79,142,170`).
- `jobctrl run` validates only `discover`, `score`, `tailor`, `cover`
  (`cli.py:59`; `pipeline/runner.py:82`). `run all` and omitted stages resolve to
  `discover` (`workflow_specs.py:672`). **`jobctrl run apply` is not an accepted
  baseline CLI invocation.** Do not add implicit application execution to `all`.
- The explicit API/RPC pipeline stage path can include Apply
  (`server.ts:1529`; `infrastructure/rpc/handlers.py:171,1347`;
  `pipeline/workflow.py:528`). `jobctrl job <saved URL> --apply` also builds that
  child workflow (`pipeline/runner.py:2852`; `workflow_specs.py:416`). The actual
  runner requires a saved canonical job even though old CLI help promises URL
  import; do not use that help text as proof of working implicit import.
- The accepted transformation keeps #1128, #1032, #1029, #1195, #1040, #1034 and
  #1018 parked. Existing batches, standing polling, exact-approved email and
  extension autofill are current capabilities, not those future expansions.
  The trusted final-form-manifest/one-shot browser-submit mediator is not present
  on the baseline and is not required for parity.

## Accepted adaptive-tailoring retirement

The coordinator explicitly resolved the old material-policy question under
#1255: retire adaptive rules whose only purpose is to tune per-job writing,
omission, persona selection or recursive repair. Their associated old adaptive
policy application/rollback machinery is not a parity prerequisite for the new
deterministic full-baseline composition. Reviewed **Resumes feedback/history**
and authored **Profile preferences** remain retained capabilities. Factual
grounding, source authority and exact approval become mandatory invariants,
rather than configurable or learned rules. This is a deliberate product
replacement, not a missing feature concealed by documentation, and this audit
does not reopen or override it.

## Initial owner notifications

- Runtime: omitted CLI operations and reduced diagnostic behavior; owner
  acknowledged backup/setup/doctor work and requested exact feature replacements.
- Jobs/Discovery: reviewed permanent-delete selection/fencing, deletion cleanup,
  source proposals, manual capture recovery, feedback and availability inventory.
  Owner acknowledged and is implementing state revisions, reviewed selection
  tokens and composition-registered public deletion ports; final candidate audit
  remains pending.
- Profile: retained legacy evidence originals/conflicts/review/recovery/decisions
  and explicit new service/CLI replacement. Owner is adding public legacy-evidence
  review/recovery/decision actions and `/v1/profile/legacy-evidence` routes, with
  original/current/conflict/token output and exact Profile/source revision fences.
  Historic confirmation validation and one-off transfer proof remain pending.
- Career: material feedback/recommendation/review/history/rollback inventory is
  distinct from career milestones. The coordinator subsequently resolved the
  adaptive-policy retirement explicitly; see the accepted record above.
- Applications/Runtime/pipeline compositor: source-backed browser-manual,
  email-send, inspection, batch/standing and CLI/pipeline distinctions sent to
  all owners. Final recurring-runtime and controlled-boundary evidence pending.
- Coordinator: no final acceptance evidence yet; current services remain under
  implementation and final composition is still an integration prerequisite.

This initial pass performed source inspection only. No production mutation,
dependency installation, private-data access, runtime reset, external action or
heavy test was performed.

## Safe-method dispatch audit after the Contacts HEAD incident

This is a bounded security follow-up on the evolving candidate, not final
acceptance. Static route inventory covered **98 GET-bearing Route declarations
in 21 target adapters** (including the catch-all route). Every declaration's
handler was inspected; selected downstream read services were followed to
distinguish ordinary reads, transient rendering, and operational writes.
No production code was changed by this auditor.

The first-principles model is caller method → `LocalSecurity` admission →
Starlette route matching → feature handler → canonical service/effect. The
invariant is that HEAD/OPTIONS cannot select a mutation branch or claim work.
The five-step cause chain was: Starlette adds HEAD beside GET; adapters assumed
only their explicitly listed methods could arrive; exact-GET/else-write dispatch
therefore selected mutation; no handler asserted its write method; the shared
CSRF boundary correctly treated HEAD as safe, so the unintended mutation also
escaped write-source admission. The owning repair is explicit mutation-method
dispatch, with safe HEAD handling. Treating HEAD as unsafe would mask the route
defect. The shared middleware now additionally preserves `state.original_method`,
normalizes HEAD to GET and suppresses response bytes; volatile GET endpoints
must inspect that original method before doing work.

| Priority | Proven path before repair | Owning layer and required control | Current evidence |
| --- | --- | --- | --- |
| P1 | `features/jobs/bootstrap.py:analysis/availability`, GET+POST `/v1/jobs/{job_id}/analysis` and `/availability`; exact GET else refresh. **Bodyless HEAD availability** called `JobsService.check_availability`, external acquisition, then canonical capture or failed-attempt write. | Jobs; only POST may acquire/analyze; HEAD reads accepted state. | Owner reports explicit POST dispatch fixed. Whole-HTTP HEAD and POST acquisition control requested. |
| P1 | `app/http.py:settings`, GET+PATCH `/v1/settings`; HEAD with valid update JSON could validate providers and update settings. | Foundation; exact PATCH only, GET/HEAD read. | Owner reports handler fix plus shared normalization; final whole-app evidence pending. |
| P1 | `app/credentials.py:credentials`, GET+PATCH `/v1/credentials`; HEAD JSON could call native `apply_batch(set)`. | Credentials; exact PATCH only. Exercise only the owned synthetic credential adapter. | Owner reports explicit GET/HEAD/PATCH fix and tracked HTTP regression work. |
| P1 | `features/profile/http.py:profile/wording/sources`, GET+PATCH `/v1/profile`, GET+POST `/v1/profile/wording` and `/sources`; HEAD JSON selected save/create/add. | Profile; exact PATCH/POST only. | Owner reports real listener proof: all three valid-write-body HEAD requests without Origin returned 200, saved DTOs and activity count unchanged; intended writes remained working. |
| P1 | `features/resumes/http.py:index/templates`, GET+POST `/v1/resumes` and `/v1/resume-templates`; HEAD JSON selected compose/template save. | Resumes; exact POST only. | Owner reports real HTTP proof preserving full resume/template lists and committed event ID, with positive POST controls. |
| P1 | `features/requirements/http.py:job_requirements`, GET+POST `/v1/jobs/{job_id}/requirements`; valid HEAD refresh body entered model-backed refresh. | Requirements; exact POST only; no accepted catalog/revision/spend change from HEAD. | Owner reports explicit GET/HEAD read and exact POST mutation; actual HTTP independent-adapter and full-root checks preserve model/spend/actions/events/snapshots on valid-force-body HEAD. |
| P1 | `features/compensation/http.py:sources`, GET+PATCH `/v1/compensation/sources`; valid HEAD JSON changed source permission policy. | Compensation; exact PATCH only. | Owner reports actual loopback HTTP HEAD left revision/events unchanged; PATCH updated both. |
| P2 | `features/offers/http.py:offer`, GET `/v1/jobs/{job_id}/offer`; HEAD fell into request JSON/action lookup instead of read. No mutation was demonstrated. | Offers; safe HEAD read. | Owner reports repaired and actual HTTP HEAD read passed. |
| P1 | `extension_transport.py:next_task`, GET `/v1/extension/discovery/tasks/next`; HEAD called `ExtensionBroker.lease`, whose `_selected` updates heartbeat and whose later CAS claims the task. Status/task/lease GETs also expire, cancel or update operational state. | Runtime; HEAD bypasses volatile broker work using `state.original_method`. Capability-authorized GET polling remains the retained protocol. | Initial request.method HEAD guards were defeated by middleware normalization. Owner reproduced heartbeat changes through the real middleware, then fixed original-method handling; 10 repeated HEAD requests now preserve heartbeat/token hash, GET positive control works. Pending-task lease nonconsumption remains an integrated E2E control. |
| P2 | `app/http.py:stream`, GET `/v1/events/stream`; implicit HEAD entered the unbounded SSE generator even though no body could be delivered. | Foundation; finite HEAD headers before streaming. | Source fix observed using original method; timed real HTTP proof remains required. |
| P2 | `features/profile/http.py:preview`, GET `/v1/profile/preview.pdf` and `/v1/profile/preview/pdf`; HEAD invoked `ResumesService.preview_profile` → `renderer.render` → persistent UUID PDF write. Ordinary preview GET also left the unreferenced artifact. | Profile adapter returns HEAD format headers before rendering; Resumes owns scoped ephemeral preview cleanup preserving accepted artifacts. | Original-method HEAD guard and ephemeral rendering source fixes observed. Owners report full-core HTTP proof for all four aliases; repeated real Chromium GET previews preserve artifact inventory/events, and HEAD never invokes a configured failure-marker browser wrapper. |

The original Contacts incident is the parent reproducer, not a newly discovered
audit result. Its collection/detail/research handlers now read on GET/HEAD;
the retained E2E suite owner added contact HEAD nonmutation coverage.

The remaining target adapters were inspected for the same pattern:
`app/preparation.py`, `app/providers.py`, `runtime_http.py`,
`features/applications/http.py`, `features/companies/bootstrap.py`,
`features/digest/bootstrap.py`, `features/discovery/bootstrap.py`,
`features/fit/http.py`, `features/interviews/bootstrap.py`,
`features/learning/bootstrap.py`, and `features/outreach/http.py`.
Their GET dispatch does not select the paired write action. Discovery source
preview reads saved observations; Learning's argument-free execute calls read;
Outreach's contact-thread read does not create a thread; Applications read,
repeat-check view and screening read do not submit or regenerate; Digest reads
public summaries and has a separate acknowledgement POST. Resume/locale export
reads the accepted PDF or renders HTML/DOCX in memory. Provider catalog GET
performs live metadata reads; browser-capability GET enumerates local supported
profiles, with synthetic isolation already enforced. These source observations
are narrower than full service or security acceptance.

`LocalSecurity` intercepts OPTIONS before handlers, so no OPTIONS mutation path
was found. Host and peer loopback admission applies to reads and writes. Normal
GET/HEAD source-origin admission intentionally matches baseline
`apps/api/src/server.ts` at `9f6f318`: safe methods skipped the mutation-source
gate. Untrusted origins receive no CORS allow-origin header; this audit does
**not** claim that an HTTP response alone proves cross-origin data exfiltration.
Extension reads still require a valid scoped capability token; pairing reads
with browser metadata require a first-party source. Permission-bearing source
policy changes were affected by the HEAD dispatch bug above, not by a newly
identified ordinary-GET permission bypass.

Meaningful recurring controls should use actual public HTTP in owned synthetic
workspaces: valid mutation bodies on HEAD with unchanged revisions/inventory/
events; bodyless HEAD availability with zero acquisition/model calls; intended
POST/PATCH positive controls; OPTIONS to destructive routes with no state
change; denied unsafe Origin/Referer/Sec-Fetch-Site cases before effects;
capability-authorized HEAD with a real pending extension task followed by one
successful GET lease; finite SSE HEAD; and preview HEAD/GET artifact inventory.
Checks must traverse the middleware and inspect canonical/effect outcomes,
because isolated handler checks missed the HEAD-to-GET composition regression.

Owner-reported proof locations are under the owned temporary QA root:
`profile-http-proof.py`, `profile-core-proof.py`, `resumes-proof/api_baseline.py`,
`runtime-head-before-9eo0n9pq/evidence.json`, and
`runtime-head-after-8hni5bhp/evidence.json` in
`/private/tmp/jobctrl-transform-1428/`. They are not committed fixtures, recorded
model outputs, or a substitute for final integrated E2E acceptance.

## Architecture retirement and algorithm audit

This pass follows the assembled CLI, API and worker imports and the feature
application boundaries. It does not rerun the repaired HEAD inventory. The
production roots are `jobctrl.cli:app` (`pyproject.toml` console script and
`jobctrl.__main__`), `jobctrl.app.server`, and `jobctrl.app.worker`.
The new CLI reaches the same composition/HTTP/actions; its retained
`company_briefing_cli.py`, `source_proposals_cli.py` and
`legacy_evidence_cli.py` are new public adapters, not obsolete handlers.

Import analysis must include **package initializers**, deferred imports and
dynamic root strings. For example, importing old `infrastructure.gmail.auth`
also executes `infrastructure.gmail.__init__`, which imports the old Gmail
client. A conservative import graph grew from 325 to 620 modules when package
initializers were included, before concurrent removals. Those counts are not
claims that every legacy callable executes: `config → database → state →
pipeline → workflow_specs` and `config → observability.llm_spans → llm →
infrastructure.temporal` include dormant function edges. They explain why
leaving whole old modules for a few helpers obstructs retirement.

| Priority / disposition | Exact source-backed boundary | Bounded owner scope and retained behavior |
| --- | --- | --- |
| P1 — root reports removed | No target app/features/CLI/runtime imports or dynamic dispatch into old top-level `apply/`, `contact/`, `discovery/`, `enrichment/`, `interview/`, `materials/`, `pipeline/`, `preparation/`, `profile/`, `scoring/`, or `workflow_specs.py`. | Coordinator removed 76 tracked retired entry/activity/workflow files, also `actions.py`, `digest.py`, `infrastructure/{apply_tools,captcha,learning,pipeline}/` and `domain/feedback/`. Exact root inventory: `/private/tmp/jobctrl-transform-1428/retired-python-entrypoints.txt`. New feature packages and rewritten CLI adapters remain the owners. |
| P1 — rehome implemented, owner proof reported | `app/model_providers.py` used private SDK helpers in whole legacy `infrastructure.analysis` and `infrastructure.llm` modules, which pulled old analysis/model-lane/spend dependencies. Native wrapper backedges also imported the old analysis modules. | Model owner created `app/provider_support/` with only pool/lifecycle, strict schemas, isolated SDK clients, auth validation, usage and safe-error leaves. Owner reports all three actual SDK boundary probes passed under a legacy-import blocker. Retired analysis classes, old spend writers and default concurrency singletons must not be copied. |
| P1 — active old-authority read repaired | Contacts default `bootstrap.py` factory → `fetcher.GatewayContactResearchFetcher` → argument-free `PolitenessGateway()` → `resolve_request_headers()` → old `config.load_discovery_crawler_settings()` → `database._refuse_unresolved_initialization` and process-global `config.DB_PATH`. The controlled synthetic fetcher bypassed this path. | Contacts repaired direct/default constructors and composed factories to use explicit public Discovery settings or builtin identity. Owner reports cold production-path proof under an import blocker and real composed Discovery-settings readback; malformed saved identity fails the owned action without old fallback. All active consumers now import neutral `jobctrl/network/`, with no old recorder/config hooks. No execution of the old metric writer was proven. |
| P1 — rehome implemented, owner proof reported | `features/applications/mail.py` imported old `infrastructure.gmail.auth` and `privacy`; auth imports old `config` at module scope. | `application_mail` moved explicit-path OAuth/token primitives into `mail_support.py`, with `mail_privacy.py` and `mail_windows.py`; no config defaults or global token access remain. Owner reports public CLI OAuth/atomic interruption proof on POSIX; Windows remains a separate required platform control. |
| P1 — rehome implemented | `runtime_commands.py` used `config.get_env_path`/`APP_DIR`; `browser_capabilities.py` used `get_config_path`, `APP_DIR`, `ConfigFileError`, `load_config_file`, `edit_config_file`. | `native_runtime_config.py` now owns the explicit native file boundary; `native_browser.py` owns the retained real Chromium probe. Target credentials use explicit native primitives. `scripts/dev-process-owner.py` now imports neutral `jobctrl.process_ownership`; the owner reports authenticated original-child stop preserved an unrelated process. Payload assertions point to the current browser/native modules. |
| P1 — pure-leaf escape and retirement complete | Interviews formerly consumed old `domain.determinations`, `job_snapshot`, `ProfileSnapshot`, claim-verification/artifact-quality values and services, IDs/tenant/LLM ports and lane contexts. Jobs/Discovery/Learning additionally used common citation/schema helpers, taxonomy and source-policy values; locale verification used `exact_values.numeric_literals`. | Current owners use shared `semantic/`, `tracing.py`, `source_values.py` and feature-owned Interview algorithms/model ports. Career handed off its replacement after the actual API/Temporal journey. Root has removed the old domain graph and dependent legacy top-level leaves; assets remain separate. |

The deletion boundary is whole retired business/adapter graphs, not
compatibility aliases. Root reports removing 259 old infrastructure/global
config/database/LLM/state/model-default/operational-metric/Profile-import/wizard
files after the helper escapes and external-script retirement. Its exact
inventory is `/private/tmp/jobctrl-transform-1428/retired-legacy-infrastructure.txt`.
`wizard/` is also an obsolete setup root: the new setup CLI does not import it.
Do not confuse the old **`config.py` module** with the separate **`config/`
asset directory**, or delete fonts, catalogs and templates with Python code.
The retained one-off `features/profile/transfer.py` performs explicit read-only
old-schema decoding itself and imports no old migration/runtime module; that
adapter is an authorized data-transfer boundary, not a runtime bridge.

The final conservative AST check parsed 468 current Python files without an
error and followed 290 modules from `jobctrl.cli`, `jobctrl.__main__`,
`jobctrl.app.server`, `jobctrl.app.worker` and `jobctrl.process_ownership`.
It includes deferred imports and implicit package initializers. It found **zero
reachable retired roots and zero missing required imports**. That check cleared
old `domain/`, `llm_lanes.py`, `llm_request_context.py` and `resume_profile.py`.
Root has since physically deleted them after Career's ready handoff; the final
deletion inventory is
`/private/tmp/jobctrl-transform-1428/retired-legacy-domain.txt`. Current filesystem
readback confirms no source or other retained files under the old domain,
infrastructure or wizard roots; only ignored generated bytecode caches remain.
The legacy top-level source files are absent, and the coordinator reports the
whole static check passed. New feature-owned `domain/` subpackages and
`app/database.py` are current owners, not residual old roots. This source result
does not substitute for complete runtime/product acceptance.

### Real ports versus renamed database access

At the scan point, 106 target table declarations were mapped to owners. No
literal sibling-private table access or sibling-private feature import was
found outside composition. Dynamic SQL reviewed in the services selected their
own table names. This is evidence for owner boundaries, not proof of complete
hexagonal separation.

Several application services still directly issue SQL, consume the complete
Runtime, construct concrete repositories or select concrete external adapters.
A `DatabasePort.connect() -> Any` whose consumer calls SQL does not create a
semantic repository port. The bounded repair is to move owned SQL into a
repository/unit-of-work adapter, keep source/revision fences in the same
transaction through public sibling ports, and select external implementations
only in bootstrap. Do not split the transaction merely to hide a connection.

| Owner | Concrete leak observed | Scope coordinated |
| --- | --- | --- |
| Companies | `service.py` originally imported/defaulted concrete fetcher, filesystem lock and whole Runtime, with 12 SQL calls. | Source-reviewed repair now uses semantic `CompanyHistory`/`CompanyUnitOfWork`, model/pages/locks/clock ports; repository owns SQL and same-transaction public Jobs/model receipt guards, acquisition owns network, bootstrap owns construction. Actual E2E acceptance remains separate. |
| Interviews / Learning / Digest | Interviews service 26 SQL calls and model adapter 2; Learning service 24 plus concrete request lock; Digest service owned watermark SQL. | Career assigned semantic stores/UoW, model-evidence store and injected lock; Digest already reported refactored. |
| Applications | `feedback.py`, `screening.py`, `repeat.py` and service contained 43 combined SQL calls; some import concrete repository helpers. | Applications and application-mail split owned repository repairs; preserve durable intent, exact source fences and ambiguous outcomes. |
| Compensation / Offers | Host Compensation service 25 SQL calls; Offers service 6. Compensation's neutral `core/` is separately port-based and was not found to import JobCtrl runtime/DB. | Owning worker assigned host repositories/UoW while preserving the neutral core. |
| Fit | `service.py` constructs `FitStore` despite accepting `DatabasePort`; service SQL and storage imports in qualification/source helpers retain concrete coupling. | Fit worker assigned semantic storage seams and bootstrap construction. |
| Discovery | `service.py` chooses HTTP/JobStreaming/registered concrete providers internally and reaches `repository.database`; `targets.py` contains five SQL calls. | Jobs/Discovery assigned provider factory injection and owned repository operations. |

Contacts/Outreach, Profile, Requirements and Resumes already had more direct
repository/model contracts. After the assigned repairs, a fresh AST and source
scan of feature service/domain/model/qualification/source/feedback/repeat/
screening/target modules found no SQLite, full Runtime, concrete repository,
storage, fetcher or network imports, and no direct SQL calls. The table records
the original defects and ownership; the fresh result supports the repaired
application boundary. It is not a claim about every possible runtime call or a
replacement for integrated E2E proof. Application-mail additionally reports
actual HTTP feedback/audit and late-send-receipt controls passing after its
repository split.

### Deterministic algorithm limits

The original `features/resumes/domain.py:choose_variants` retained every reachable
requirement-union mask and copied complete choice tuples per transition. A valid
structural input with 25 achievements, two approved alternatives each supporting
different requirements, and 50 requirements produces **2^25 = 33,554,432 states**.
The requirement extraction contract admits up to 100 rows. This is an analytic
construction, not a heavy benchmark or model-output fixture. Composition ran
before the SQLite writer but had no cancellation during expansion, risking
process RAM/CPU and worker responsiveness.

Resumes has now implemented exact achievement/requirement connected components,
factored guaranteed coverage, cached mask weights, ranked backpointers,
identical-mask pruning, cancellation and explicit state/path/transition budgets.
The source review found no objective/tie defect: guaranteed coverage is constant;
full support sums retain complementary depth; independent component objectives
add; local lexicographic minima combine into the global ordered choice minimum.
Finite refusal returns no approximate result and preserves accepted artifacts.
The owner reports actual API controls in
`/private/tmp/jobctrl-transform-1428/resumes-proof/api_solver_scale.py`: sparse
25×2/50 requirements completed in 0.149 seconds with 25 components, 50
transitions and peak two states; guaranteed shared coverage with interleaved
achievements retained the exact expected IDs; a connected 12-achievement case
used 4,096 states; an irreducible 25-achievement case refused at 50,001 states
in 1.862 seconds. These are structural external choices, not semantic labels or
an evaluation corpus. The owner checked the prior accepted PDF/hash survived
refusal and ready composition made no model calls. This audit reviewed the
algorithm's decomposition and tie arithmetic; it did not rerun that proof.

Requirements has a separate long-lived-catalog ceiling: 12 candidates per page
and 128 pages per attempt permit at most **1,536 small meanings** in a complete
novelty sweep. At 1,537, a truly new requirement always fails on the next page
after 128 model comparisons. Uncommitted negative pages are discarded, so
retries cannot make progress. At 1,536 meanings, an admitted 100-row extraction
can need 12,800 comparison calls. Reuse may still succeed early; the refusal is
correctly fail-closed and does not falsely establish novelty. The existing
retrieval ranking uses the first extracted requirement's literal phrase for all
rows and loads/verifies the full catalog/index.

Requirements now persists source/qualified-meaning/catalog-revision-bound
accepted comparison progress, uses per-incoming retrieval, and counts only new
calls against the refresh budget. The owner reports an actual HTTP/gateway
1,537-entry continuation proof: after 1,524 comparisons the first attempt
paused, app/HTTP restart and a structural next-page failure preserved progress,
and the final retry admitted the novel meaning only after all 129 successful
pages were recorded, with each page called once. The synthetic historical
catalog precondition is explicit; the proof does not claim those historical
entries were all created by live provider calls.

The first cache implementation trusted its own copied receipt metadata and
result hash. This audit required a canonical authority join, since that
self-consistency cannot establish a recorded model determination. Current
`features/requirements/model.py:_checked` joins `gateway.receipt(receipt_id)`
and validates succeeded status, operation, provider/model/lane/prompt/input/time,
exact typed-result equality and the strict source validator. The owner reports
actual HTTP missing-receipt and same-operation/wrong-input-receipt controls both
returned `422 model_cache_receipt_invalid`, preserved accepted revision/catalog,
and made zero model calls; restoring the exact receipt resumed only missing
work. The 1,537-entry continuation proof also passed with these live joins.
Evidence scripts are `cache-receipt-authority.py` and `large-continuation.py`
under the owner's temporary QA directory. No lexical equivalence, top-k novelty
shortcut or approximate novelty is admitted.

### Setup capability follow-through

Baseline `cli.py:1017` exposes real setup modes: interactive hidden Claude/Google
credential entry, explicit Codex isolated-home enrollment, provider readiness,
dry-run/noninteractive/JSON controls, final doctor, and source dependency/browser
provisioning. `wizard/init.py:764` additionally guides Profile/source and Discovery
onboarding, preserves existing Profile/search settings, and fences pending source
copies. The original target health-only `init` gap is now closed: current
`cli.py:init` supplies explicit startup and Profile/import/Discovery/provider
next steps into the real owner flows. `setup` implements hidden native key entry,
explicit managed Codex login/verification, live catalog/readiness checks,
revision-fenced selection and mutation-free dry-run; source provisioning belongs
to current install/dev entry points. The coordinator reports the actual shared
CLI E2E passed. The full source/web run still has doctor integration repairs,
so this is focused completion rather than an overall pass. Future-only CapSolver
storage is not proof of an active CAPTCHA solver, and obsolete framework
prerequisites need not return.

### Remaining behavior and acceptance gaps

1. **Digest CLI retention:** reconcile the missing one-read `--min-fit-score`
   override and generate-then-acknowledge result/watermark behavior recorded in
   the ledger. This is the remaining concrete CLI parity difference identified
   during the current status readback, not a request to restore old Digest code.
2. **Complete final-candidate source/web evidence:** finish the assigned repairs
   from `rCUXK8`, then record the complete result, candidate identity and timings.
   Focused owner handoffs and native partitions do not close those observed
   failures or prove every ledger row.
3. **Offline demo and one-off cutover evidence:** retain final demo acceptance
   as pending. Reconcile the dedicated synthetic full-Profile/source transfer
   evidence separately from recurring E2E; do not infer it from normal CRUD or
   native legacy-start refusal. Rows without final evidence remain obligations,
   rather than fresh claims that their implementation is absent.
4. **Native qualification scope:** the passing local unsigned payload controls
   establish the recorded lifecycle/custody behavior. Published signed/notarized
   predecessor and any remaining platform qualification stay separate; no
   release, deployment or GitHub completion is claimed.

No additional capability retirement is authorized by a missing proof. The
accepted retirements remain Cover and the specified adaptive Tailor policy;
reviewed feedback and authored preferences remain. Browser final submission
remains manual because that was already the actual baseline behavior, while
read-only inspection, reviewed extension autofill and exact-approved email
execution retain their separate contracts.

### Permanent-deletion ownership clarification

At baseline `9f6f318`, `write-model.ts:730` enables foreign-key enforcement and
calls `purgeJobRows`. `schema_v7.sql:832` cascades job Interview prep/items;
`schema_v12.sql:8` and `:24` also cascade job interview notes and note history.
Independent career cohorts/milestones/attempts remain retained reference records,
explicitly counted by `job-data-purge.ts:628`, even during whole-job-data purge.
The Career/Jobs owners were told to remove job-scoped Interview records but
retain honest historical Learning snapshots with missing/stale source state.
Contact/Outreach references detach under `write-model.ts:1022` rather than
deleting those independent aggregates. No blanket feature-data purge is implied.
