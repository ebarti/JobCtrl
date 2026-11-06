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
**Recorded application journeys passed:** the hosted Browser job on `09f9d5c`
passed 23/23 source journeys including the demo, and the latest database-fixed
installed payload passed 22/22. These results apply to their recorded candidates;
the final operational result and hosted checks are tracked in
[#1428](https://github.com/ebarti/JobCtrl/issues/1428) and
[PR #1454](https://github.com/ebarti/JobCtrl/pull/1454). This preparation snapshot
does not establish a later merge or release. Earlier partial source runs and the prior installed payload
remain historical evidence rather than being relabeled as current.

- `SOURCE COMPLETE`: current source and static checks close the stated boundary.
- `FOCUSED PASS`: named focused public journeys passed; wider acceptance remains
  separate and any platform/payload qualification still applies.
- `VERIFIED`: the named boundary was exercised on its recorded candidate; this
  never implies all candidates, platforms or the entire transformation passed.
- A source-complete row does not claim every variant of its behavior has a
  recurring assertion; the named focused proofs state their actual coverage.
- `SUPERSEDED`: deliberately retired by an accepted product/architecture decision,
  with the retained user value and new authority recorded explicitly below.
- P0 prevents an honest cutover; P1 prevents feature acceptance; P2 is a retained
  usability/operations obligation. Priority is not a claim that unfinished work
  has already been delivered incorrectly.

The latest evidence disposition is:

| Boundary | Current result | Remaining qualification |
| --- | --- | --- |
| Legacy backend authority | Production source files in old Fastify, Python workflow/business roots, infrastructure, domain and global config/database/LLM roots are physically deleted. The earlier transitive closure was clear; whole static checks and the full installed suite passed. | Whole-head hosted CI remains open. No temporary runtime bridge is retained. |
| CLI setup, onboarding and Digest | Source and installed CLI onboarding/setup passed. The separate actual Digest proof passes one-read threshold override, generated-at acknowledgement, stale acknowledgement refusal, unchanged settings and zero added model calls. | The earlier Digest parity defect is closed; hosted CI remains separate. |
| Full Profile and supporting-source transfer | Final one-off synthetic `profile-transfer-umx5un0g` and identity `profile-identity-m8gba6hd` proofs are reported passed in the owning Profile record; full source bytes/raw review data and known versus uncertain authority are covered. | No real-user reset/transfer occurred. This is separate from recurring fresh-workspace E2E. |
| Native lifecycle and process custody | Frozen local native lifecycle partition passed in **47.659 seconds** (eight cases); custody passed in **61.296 seconds** (seven cases), with cleanup and independent no-listener readback. Both Darwin partitions also passed hosted. | These use real compiled binaries and owned synthetic payloads. Signed/notarized published-predecessor qualification and the remaining platform matrix are distinct release gates. |
| Source/web acceptance | Hosted Browser job [128139371277](https://github.com/ebarti/JobCtrl/actions/runs/42289605507/job/128139371277) on `09f9d5c` passed `e2e-DUQtlZ` **23/23**, including the demo. Linux x64, four CPUs, Node 22.21.1; preflight/build/journeys/total were 3,524/20,738/314,112/338,686 ms. | Lockfiles and web build were unchanged. This establishes the recorded Browser job, not all jobs or any later candidate. |
| Full installed application | Database-fixed `e2e-kGHZtb` passed **22/22**, zero skipped/flaky/unexpected cases: 198,682 ms journeys and 200,351 ms total, with 34 ms snapshot, 1,598 ms preflight and no web rebuild. Real bundled import origin, pinned CPython 3.12.12 and Temporal 1.7.3. | This unsigned minimal payload has no provider packs and does not qualify the full distribution, signed predecessor or later candidate. |
| Offline demo | `e2e-tNQ809` and `demo/final-browser-proof.json` passed the actual consent Worker/D1/browser-local edit, wording approval, accepted PDF and cleanup journey, with zero product requests or page/console errors. The hosted Browser run also includes the demo. | This verifies the tested demo journeys, not a hosted deployment or live model quality. |
| Platform and CI gates | Original PR candidate `0db` passed the other hosted contexts, including Backend `128144844565` and Browser `128144844490`; its Windows credential failure was fixed. Windows credentials [job 128146721619](https://github.com/ebarti/JobCtrl/actions/runs/42291768416/job/128146721619) on `23bafd876` passed 37 controlled and 21 native checks with cleanup confirmed; the same focused workflow passed Linux and macOS. Windows Gmail and both Darwin lifecycle/custody partitions also passed on recorded candidates. | Final whole-head CI and the signed-only schema-2 exact-identity predecessor harness operational proof are required before merge; their current results belong to #1428 / PR #1454. |

Before the full hosted source pass, the local source-run accounting was **18 + 3 + 1 distinct passing journeys**:

| Run | Actual result | Journey / total milliseconds |
| --- | --- | --- |
| `e2e-w989ac` | 18 passed, four failed; all original core journeys passed | 179,066 / 188,640 |
| `e2e-cOQbyj` | Three passed, one failed; Learning, genuine lost Preparation acknowledgement, and negative Jobs/deletion controls passed | 29,921 / 39,849 |
| `e2e-kz95to` | One passed; complete Jobs pagination/sort/facet/filter/saved-view journey | 9,646 / 19,475 |

All three timing records identify frozen Python
`e6e860e538926932ecba936c75ffe99e11957147b131c81777b490b821789631`
and combined Python/policy
`0c644feb105e9c26c53e7cf8dc77731c0d3014b4d426f8a7a5918b9c6572aacb`.
The last web build is
`0b172f2c478f9d690e77aa43a3485b4e977abad3547d8460027a75ca84a1d282`.
The earlier installed run `e2e-Htgt0Q` subsequently passed 22/22 on this web
hash with 2,402 ms composition preflight. Its wheel hash was
`33d3504d3e0dd50950627ae9d3d441d1e0925156e5e4b26902f6bd6cc2ff24be`.
The source conflict-accounting repair passed a focused rerun rather than
suppressing an unobserved class of console errors. These records remain tied to
their earlier candidates.

The earlier hosted Browser run's frozen Python source SHA-256 was
`aa0464efab513542ad7446a06eea2e9e8927bcaf530c8ec21daeaf36fe367051`.
The subsequent credential-fixed installed `e2e-npLcAJ` passed 22/22 using wheel
`7d34a450c18292b160d5d84e135b96aa032ff3e81eed9d713e3a9c51f44b8e93`
and payload `8b77fe37fae8b8cc0fcb5d2b4fdab1effdd0cefc07b2adb81204d3254ece9a81`.
That is historical evidence for its own payload.

The latest database-fixed `e2e-kGHZtb` has the same 313 source files and 3,313,583
bytes in both the frozen source and installed wheel, with SHA-256
`a94f09c4962c950675a7b5b04e1ecf557647b06387db113f5f75127daae06b70`.
Its wheel SHA-256 was
`2b238d4ffbfe5916c3b778ee016f6d12b5a5c77f789624a23f1e3fec3f2f5766`;
the whole 8,247-file, 1,136,209,416-byte payload SHA-256 was
`72610e9386f2768f9dddab3214577cf07e3560f85664ef3479d164eb5fa43cf8`.
Its 99-file, 10,597,612-byte web candidate SHA-256 was
`0b172f2c478f9d690e77aa43a3485b4e977abad3547d8460027a75ca84a1d282`.
Installed `results.json` and `timings.json` record exit zero, 22 expected results,
no skipped/flaky/unexpected results and unchanged web build/lockfile. The
preparation, source equality and installed-origin receipts are under
`/private/tmp/jobctrl-transform-1428/installed-application-_ajwp183/`; they
place JobCtrl and its dependencies inside the extracted payload, not the checkout.
The Windows startup failure was `OSError` `errno 9` from flushing the staged
database opened read-only; the fix opens it writable for the flush.

Digest evidence is `digest-cli-proof-rau9vjop/proof.json`. Profile's observed
proof coverage is recorded in [its owning implementation record](2026-11-06-profile-transformation.md#observed-verification).
Demo evidence is `demo/final-browser-proof.json`, tied to `e2e-tNQ809`:
one passed journey, 23,691 milliseconds total, actual PDF text/page validation,
no authored-text leaks, and owned listener cleanup. None of these controlled
model boundaries establishes live-provider semantic quality.

Native results were read from
`/private/tmp/jobctrl-transform-1428/native-lifecycle/native-final-candidate.json`
and `native-partitions-proof.json`, including the respective
`jobctrl-native-lifecycle-WBuAOA/result.json` and
`jobctrl-native-lifecycle-GMT76m/result.json`. The candidate record contains
source and binary hashes. It also records limited post-run harness bookkeeping
adjustments; the required partition inputs and assertions are reported
equivalent, rather than claiming every final harness byte ran unchanged.

The completed native first-selection repair passed an actual public full Profile
transfer/readback, compiled installer, native start/stop/restart and complete-pair
reinstall in **32.683 seconds**, with 19 refusal controls. The one-time
workspace-local permission prevents a stale transfer receipt from authorizing
new history under another runtime home. Unknown/legacy identity/version controls
preserved the complete workspace inventory; an exact-current metadata inspection
explicitly records SQLite companions without canonical database, receipt,
selection or permission changes. Eight owned PIDs exited and fixed ports were
free, with an unrelated control preserved until cleanup through its own handle.
This owned unsigned operational proof is in
`native-transfer-admission/operational-result.json`; final launcher/installer
hashes are `db290a9467e37f228689220f119ba4e4b111f1147a77b7c537f008d12f0fe6af`
and `72caa70d40bf4846da1f50db2ac488a3e9cd1cb3ca58164a478dd5a13038b34e`.
Declared-platform build/vet passed. Independent review closed the release harness
at `e30abba907adcfec805c81b19b21f9560710f47e52d7b7e0531baa62a4c287a0` with no
remaining scoped findings; its final exact operational rerun is a distinct
gate recorded in #1428, separate from this first-selection proof and protected
release qualification.

## Capability ledger

All baseline source references below mean the file at `9f6f318`; current target
paths are beneath `workers/automation/src/jobctrl/` unless stated otherwise.
The source-complete entries record retained implementation contracts, not new
missing-feature claims. Focused passes apply to the named observations below;
they do not claim a separate recurring assertion for every option of a feature.

| Priority / state | Retained capability and exact baseline entry | New owner / current implementation | Current replacement and evidence scope |
| --- | --- | --- | --- |
| P0 · SOURCE COMPLETE | One local authority: `apps/api/src/server.ts`; `cli.py`; old RPC/Temporal worker | Foundation: `app/`; Runtime: new `cli.py`, `launcher/internal/launcher/python_application.go` | Legacy authority roots are deleted; conservative imports and whole static checks passed. Native partitions and the full installed suite exercised real Python API/worker/Temporal and canonical CLI. Whole-head hosted CI remains open. |
| P0 · FOCUSED PASS | Profile facts/preferences/attestations/style/template: `GET/PATCH /v1/profile` (`server.ts:3111,3180`), `infrastructure/profile/` | Profile: `features/profile/{models,repository,service}.py` | Full-run form round-trip, competing same-revision saves, stale approval refusal and baseline inventory passed. Owner core/identity proofs additionally preserve independent opaque IDs, nested authored fields, exact source authority and zero-state-change HEAD controls. |
| P0 · FOCUSED PASS | Full Profile cutover including retained originals and review decisions: `legacy_evidence_cli.py`; old profile tables/files | Profile transfer + Runtime `profile-transfer --source --target --confirm-profile-only-reset` | Final `profile-transfer-umx5un0g` proof passes full baseline/source/attachment/review preservation, exact source digest unchanged, known versus uncertain historic authority, exact target round trip, overwrite refusal and incomplete-browser refusal before mutation. Identity proof `profile-identity-m8gba6hd` preserves independent namespaces. Synthetic one-off only; no real-user reset or migration. |
| P1 · FOCUSED PASS | PDF resume import preview/confirmation: `POST /v1/profile/import-resume` (`server.ts:3463`); `/profile/import/{upload,preview,confirm}` | Profile `service.py:import_resume/accept_import`; core web Profile | Owner `profile-provider-proof.py` passes real PDF extraction without fact mutation, exact selected-section acceptance, retained original PDF bytes and failed/invalid output preservation through the real HTTP/gateway boundary. |
| P1 · FOCUSED PASS | Profile required-bullet coaching and target-role suggestions: `/v1/profile/required-bullet-suggestions`, `/target-role-suggestions` (`server.ts:3250,3376`) | Profile `coach_required_bullets`, `suggest_target_roles`; core web Profile | Owner provider/authoring proofs pass receipt-bound role suggestions, stable coaching IDs, invalid foreign-citation preservation, concurrent proposals, explicit rejection/defer reuse without new calls and cancelled-provider refusal. Full-run exact approval/conflict journeys passed. |
| P1 · FOCUSED PASS | Legacy evidence list/recover/decide: `legacy_evidence_cli.py:31,37,64` | Profile `/v1/profile/legacy-evidence` read/recover/decision routes + Runtime `legacy-evidence` | Owner recovery proof passes exact confirm/reject/defer decisions and retains all decisions/revisions when recovery authority is unavailable. Final transfer proof covers original cells, valid historic confirmations and honest review-required unknowns. |
| P1 · FOCUSED PASS | Manual Jobs, URL import, source snapshots, refresh: `/v1/jobs`, `/v1/jobs/import-url`, job detail; direct CLI `job` | Jobs `features/jobs/{bootstrap,service,repository}.py` | `e2e-w989ac` passes actual browser manual capture and manual Jobs in a reduced composition. Owner HTTP controls cover source revision/receipt replay and failed acquisition preserving the accepted posting; source snapshots and named refresh paths are implemented. |
| P1 · FOCUSED PASS | Posting availability: `endpoint-spec.ts:checkPostingAvailability`; CLI `check-availability` | Jobs acquisition/page interpretation | Owner `jobs-discovery/posting-model-proof.json` passes actual HTTP acquisition/interpretation, active revision acceptance, changed-input refusal and invalid-provider preservation. HEAD performs zero acquisition/model work while POST remains the explicit refresh path. |
| P1 · FOCUSED PASS | Reviewed permanent deletion, hide/restore, bulk selection: `/v1/jobs/permanent-delete-selection`, `/bulk-delete-permanent` (`server.ts:1968,1974`) | Jobs `bootstrap.py:delete_selection/bulk/visibility`; owned repository and public deletion callbacks | Original raw-ID defect is repaired. `e2e-cOQbyj` passes unavailable-criteria and exact reviewed-selection deletion fences. Owner Resumes proofs additionally retain bytes on transaction rollback, refuse foreign file replacement and complete exact retry idempotently. |
| P1 · FOCUSED PASS | Bulk failed-stage retry and pending preparation: `/bulk-retry-failed`, `/bulk-run-pending-preparation`; per-job retry/run/cancel (`server.ts:2006,2074,2355,2436,2760`) | Jobs UI + `app/preparation*` + CLI recipe/retry commands | Current actions retain selected/pending scope and per-stage outcomes. `e2e-cOQbyj` passes genuine lost admission acknowledgement followed by reload/reconciliation without duplicate admission; full-run cancellation and worker replacement preserve accepted artifacts. |
| P1 · FOCUSED PASS | Discovery providers, targets, settings, schedules, search controls: `/v1/discovery/settings`, `/sources`, `/sources/:id/state`; CLI `discover/run` | Discovery `features/discovery/`; Jobs ingestion public port | The full run passes controlled external provider ingestion into canonical Jobs. Registered providers, settings/targets, schedules and source controls are implemented; this focused pass does not claim live validation of every external provider family. |
| P1 · SOURCE COMPLETE | Discovery source preview, proposals, locator promote/reject/reset: `server.ts:1351,1359,1363,1388`; `source_proposals_cli.py:46,56,64` | Discovery `bootstrap.py` source-proposals/from-history and locator decision routes + Runtime dedicated CLI | Current proposal lifecycle preserves opt-in generation, origin receipts, rejection/disabled intent and explicit suppression reset. The initial missing-path finding is closed; this row claims source completion rather than a dedicated recurring proposal journey. |
| P1 · SOURCE COMPLETE | Manual capture queue/recovery and quarantine: `/v1/discovery/manual-capture/:id/{prepare,import,supersede,dismiss}`, `/quarantine/:key/decision` | Discovery manual-capture prepare/import/supersede/dismiss routes; Jobs-owned quarantine through public ports | Current queue/review paths implement exact review lifetimes, provenance, supersession/dismissal and retry identity. The separate full-run extension journey proves canonical capture replay/restart; it is not represented as an assertion of every manual-review option. |
| P1 · SOURCE COMPLETE | Discovery feedback and role-match suggestions: `/v1/discovery/feedback`, `/role-match-feedback/:id/decision` | Discovery `bootstrap.py` feedback/refresh/decision routes + public model/source inputs | Equivalent named paths implement reviewed source-bound determinations and explicit literal filter changes, with no lexical meaning or silent settings edit. Initial route omission is closed. |
| P1 · FOCUSED PASS | Company briefing configure/show/refresh: `company_briefing_cli.py:69,92,98`; job/interview/digest reads | Companies `features/companies/` | The full-run Discovery/Companies journey passes a sourced briefing and retains it after failed refresh. Semantic repository/model/pages/lock ports and public source fences replace old Runtime/SQL coupling; optional composition remains supported. |
| P1 · FOCUSED PASS | Requirement extraction, occurrences, qualified meaning and corrections: former score/posting readers | Requirements `features/requirements/{service,repository,http}.py` | Full-run meaning-authority controls pass recorded-ID reuse, qualified distinction, invalid/stale refresh refusal and accepted-state preservation. Separate actual HTTP continuation and canonical receipt-join proofs pass the large-catalog and damaged-cache controls described below. |
| P1 · FOCUSED PASS | Person qualification, eligibility, scoring/corrections and evidence map: `/v1/jobs/:key/score-correction`, `/v1/scoring/*`, `/v1/evidence-map` | Fit `features/fit/`; public Profile/Requirements snapshots | The full approved-wording journey exercises factual Fit separately from document coverage; source-bound requirement/qualification and stale refresh controls pass. Owner qualification/query proofs supplement those focused assertions; no semantic-accuracy score is inferred. |
| P1 · FOCUSED PASS | Reusable approved wording with explicit decisions and suppression | Profile wording library + Fit authoring port | Full-run pending proposal and exact Profile approval controls pass; Profile owner authoring proofs also pass reject/defer origin reuse with zero calls, exact source fencing and cancelled-provider refusal. Fit/Resumes cannot silently approve wording. |
| P0 · FOCUSED PASS | Full-baseline resume composition and baseline-copy/off: old Tailor + #1426 accepted behavior | Resumes `features/resumes/{domain,service}.py` | Full-run baseline and approved-tailoring journeys pass complete role/achievement inventory, exact approved wording and accepted PDF preservation. Owner solver proofs cover exact sparse/dense choices, finite refusal, ready-compose zero calls and actual worker cancellation/performance. |
| P1 · FOCUSED PASS | Editable resume drafts, revisions, comments, rendering and manual acceptance: `server.ts:1823–1941`; `endpoint-spec.ts:renderResumeReviewDraft` | Resumes service `edit/approve_edits/review/render/accept/comment`; core web Plate surfaces | The actual Plate edit/approval journey passes separate draft versus accepted revisions, full inventory and historical PDF bytes. Tailored review/render failures preserve the accepted PDF; explicit advisory override is exercised without falsifying review status. |
| P1 · FOCUSED PASS | Resume template library/default/per-job assignment/current-material refresh: `server.ts:1769–1810` | Resumes repository templates + web materials | Owner real-API baseline/template-save/render controls passed, and full-run real PDFs use the current renderer. Custom template library/default/per-job selection paths are implemented; this does not claim a separate browser assertion for every template option. |
| P1 · FOCUSED PASS | PDF/HTML preview, DOCX export and OS opening: `/v1/artifacts/:id/{download.docx,preview.pdf,preview.html,open}`, Profile previews (`server.ts:2942–3147`) | Resumes renderer + runtime/browser download/open adapters | Full-run accepted/historical PDF.js preview, PDF text/page images and browser-download hashes passed. Owner repeated preview/HEAD and DOCX-open/save/reopen controls passed, preserving durable inventory and accepted bytes. Native OS opening remains within installed/platform qualification. |
| P1 · SOURCE COMPLETE | Locale translation/review/accepted exports: `endpoint-spec.ts:materialLocaleVariants/acceptedMaterialExports`; CLI `material-locale/material-export` | Resumes locale owner + Runtime named CLI commands | Current paths implement source-linked independent locale revision/review/acceptance and accepted PDF/DOCX export; baseline-copy and locale model use remain distinct. This row records source completion, not a claim of live translation quality. |
| P1 · SOURCE COMPLETE | Reviewed material feedback and authored preferences: `server.ts:1857`; old material-feedback readers and Profile preferences | Resumes feedback + Profile | Retain reviewed feedback/history and user-owned preferences. Do not silently equate these with career milestones. Adaptive rules that only tune writing/omission/personas/repair are explicitly superseded by #1255; factual grounding is now invariant, not a learned policy option. See the accepted retirement record below. |
| P1 · SOURCE COMPLETE | Screening-answer library, proposals/review/history, application-bound answers: `endpoint-spec.ts:screeningAnswers/writeScreeningAnswer`; CLI `screening read/write` | Applications `features/applications/screening.py` | Current typed forms, review, reusable answers, prior bindings/history, semantic provenance and stale-source rejection; never infer protected attestations or submit from library edits. |
| P0 · FOCUSED PASS | Apply payload review, exact approvals, repeat checks/override, manual browser boundary and approved email execution: `/v1/apply/review-queue`, per-job apply-review/repeat/apply; CLI `apply` | Applications + Resumes accepted public snapshot + browser/mail adapters | The full uncertain-send journey passes current Fit, exact prepared/rehearsed approval, changed-input invalidation, persisted intent before real controlled mail POST, worker death and no second send. Browser final submission remains manual as at baseline; no Cover authority remains. |
| P1 · SOURCE COMPLETE | Read-only browser inspection and typed findings: `apply/prompt.py:72`; `domain/apply/terminal_report.py:36`; `domain/apply/process_manager.py:511` | Applications `browser.py`, `inspection.py` and rehearsal service | The initial inspection gap is repaired: current actual page observations feed source-cited ready/expired/CAPTCHA/login/email-only/manual/failed/uncertain determinations. Email candidates require literal observed destination plus accepted-resume citations and a new payload/approval. Final composed proof remains separate; browser execution still requires manual submission. |
| P1 · SOURCE COMPLETE | Finite/continuous Apply batches and settings-controlled standing loop: `cli.py:1590,2429,2578`; `apply/auto_apply.py:63`; `apply/workflow.py:168` | Applications `batch/run_approved` + Foundation recurring runtime + CLI/pipeline adapter | Bounded batch, approved polling and settings-controlled recurring registration are implemented with stable item identities, eligibility/score/capability/budget guards and explicit enable/disable. No fresh approval is invented on retry; `run all` has no implicit Apply stage. Full-run uncertain-send restart proof covers at-most-once effects without claiming every loop option was separately exercised. |
| P1 · FOCUSED PASS | Manual outcomes, outcome suggestions, Gmail scan/auth: `/v1/jobs/:key/outcomes`, `/v1/outcome-suggestions/:id/decision`, `/v1/outcomes/gmail/scan`; CLI `gmail-auth` | Applications mail/outcome owner + Runtime native auth | Owner actual HTTP mail/feedback/audit and late-receipt controls passed after repository separation, plus POSIX CLI OAuth interruption/recovery proof. Capture/review/history and analytics paths are implemented; no real mailbox access or live communication is claimed. |
| P1 · FOCUSED PASS | Contacts CRUD/import/provenance/research/candidate confirmation: `server.ts:3804–4025` | Contacts `features/contacts/` | The full contact-research journey passes explicit confirmation and distinguishes invalid output from an empty result. Owner production/default networking proofs pass canonical settings consumption, private-DNS refusal and honest config failure without legacy fallback. |
| P1 · FOCUSED PASS | Outreach draft/thread review, send logging, follow-ups: `server.ts:4027–4260` | Outreach `features/outreach/` | The full Outreach journey passes reviewed manual-send recording once and preserves its receipt after sources change. Draft/thread/follow-up controls are implemented; this capability remains a reviewed manual-send workflow. |
| P1 · FOCUSED PASS | Interview research catalog/guidance, prep/history, notes and session context: `endpoint-spec.ts:interview*`; per-job generate-interview-prep | Interviews `features/interviews/` | Full-run preparation honors explicit empty evidence selection and preserves accepted preparation on failure. The repaired notes/Learning/Digest journey passes source ownership. Catalog/guidance/history/session paths and optional Companies composition are implemented. |
| P1 · FOCUSED PASS | Career evidence comparison, aspirations/plans/milestones: `endpoint-spec.ts:careerLearning/writeCareerLearning` | Learning `features/learning/` | `e2e-cOQbyj` passes the repaired notes/Learning/Digest journey with a genuine observed-response delivery fault. Learning activity remains independently owned and cannot write Profile evidence or increase Fit; retained cohort provenance survives job deletion. |
| P1 · FOCUSED PASS | Digest creation/read/acknowledgement and score threshold: `GET /v1/digest`, `POST /v1/digest/acknowledge`; CLI `digest` (`cli.py:1866`) | Digest public-summary composition and acknowledgement repository; Runtime `cli.py:digest` | The CLI defect is repaired. `digest-cli-proof-rau9vjop/proof.json` records threshold counts four/two, invalid input rejection, acknowledgement equal to generatedAt, stale acknowledgement unable to move the watermark backwards, unchanged settings and zero added model calls. `e2e-cOQbyj` also passes UI digest review. No external delivery capability is inferred. |
| P1 · FOCUSED PASS | Posted/market compensation, provider policy, refresh: `/v1/compensation/sources`, `/v1/jobs/:key/compensation/*`, refresh endpoints; CLI `compensation-refresh` | Compensation neutral `core/` plus adapters; composed Jobs grid/filters and feature panels | The full compensation journey passes source-cited posting/manual-report evidence and accepted-state preservation on failure. Final Jobs query passes composed sorting/filtering/saved views. Direct/geographic lineage, custom source policy and neutral-core ports are implemented; every provider is not claimed live-tested. |
| P1 · FOCUSED PASS | Actual offer terms/scenarios/history/corrections/decisions: `apps/api/src/offer-routes.ts` | Offers `features/offers/{service,http}.py` | The full Offers journey passes unknown terms, correction history and explicit compensation-source permission. Source-bound offer revisions, decisions and communication drafts remain distinct from application state. |
| P1 · SOURCE COMPLETE | Dashboard, analytics, evidence map, activity details, pipelines, runs: `server.ts:1000–1257,2891`; `apps/web/src/routes/` | Web shell composition + feature public panels/queries; Foundation action runs/events | Current named routes and owner-read compositions are present; the initial missing-shell claim is closed. Full-run boundary proof observes one event connection and committed browser updates; action/run/recovery controls are exercised by core journeys. This does not claim every analytics view has a separate recurring assertion. |
| P1 · FOCUSED PASS | Settings, provider model inventory/verify, credentials/batch/delete, browser capability enable/disable/profile-copy: `server.ts:3500–3770`; `endpoint-spec.ts:provider*` | Foundation Settings/credentials/model providers + runtime native capabilities | Actual shared CLI onboarding passes hidden credential entry through the canonical adapter and provider/model settings without changing authored state. Current credential/browser capability and budget controls are implemented; real provider/native-platform authentication remains separately qualified. |
| P1 · FOCUSED PASS | CLI setup/init/doctor/backup/run inspection/retry: old `cli.py:1003,1017,2180,3271,3404` | Runtime new `cli.py`, `runtime_commands.py`, native launcher | Source and installed journeys pass actual CLI onboarding with authored-state preservation and hidden key saved through canonical setup. Doctor policy capture is repaired; native partitions prove coherent paired backup/restart and owned-process behavior. Separate Digest proof also passes. Hosted CI remains open. |
| P0 · FOCUSED PASS | Extension token/auth, capture/ack, discovery claim/task/lease/result/cancel, typed autofill/map: `server.ts:658–949`; `apps/extension/src/local-api.ts` | Runtime extension transport + Foundation auth + Jobs/Discovery/Applications | All three full-run Extension journeys pass pairing/rotation/revocation, canonical capture replay across restart and real pending-task HEAD/lease/private-DNS/cancellation fences. Reviewed fill-only mapping is implemented; no automatic final submission is implied. |
| P1 · VERIFIED | Public offline demo workspace, synthetic edits/history/consent/events/reset/export: `apps/web/src/demo/{portFactory,capabilities,DemoApiClientAdapter}.ts` | Demo owner + web feature transports | Actual isolated `e2e-tNQ809` and final demo proof pass real consent Worker/D1, local exact-wording approval, durable edits and accepted PDF. Zero product requests, authored-text leaks, console errors and page errors; owned cleanup passed. Verified for the recorded demo bundle, not a hosted deployment. |
| P0 · FOCUSED PASS | Installed/source startup, stop/restart, provider/browser packs, backups/rollback/update, static assets and renderer | Runtime `launcher/`, `scripts/dev`, `packaging/distribution/` | Native lifecycle/custody partitions passed in 47.659/61.296 seconds with coherent backup/update/rollback and unrelated-process preservation. The full installed application then passed 22/22 on pinned runtimes and real bundled imports. Hosted CI and distinct signed/platform release qualifications remain open. No release/deployment is implied. |
| P0 · VERIFIED | E2E-only fresh target suite and real product coverage | E2E `apps/web/e2e/harness/`, `scripts/run-e2e.mjs`, `docs/developer/qa/python-journeys.md` | Hosted Browser `e2e-DUQtlZ` passed 23/23 including demo; database-fixed installed `e2e-kGHZtb` passed 22/22 without skipped/flaky/unexpected cases, 198,682 ms journeys/200,351 ms total. These qualify recorded candidates, not pending whole-head CI or signed release qualification. |

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

The initial target `features/applications/browser.py:inspect` only returned
partial check labels. That gap is repaired: the current bounded read-only page
observation feeds `inspection.py` source-cited terminal determinations and
reviewable email candidates, with no submit authority. Bounded batch and
`applications.run_approved` plus recurring-runtime integration are implemented.
The actual full-run application journey proves exact approval, durable intent,
worker death and no duplicate email send. It does not turn browser inspection
into automated final submission or imply every standing-loop option was a
separate browser assertion.

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

## Historical notifications and current disposition

- Runtime's missing setup/backup/doctor behavior and the later Digest CLI
  difference are implemented and have the focused public proofs recorded above.
- Jobs/Discovery's reviewed deletion, source proposals, capture recovery,
  feedback and availability replacements are implemented. The repaired negative
  selection and complete Jobs query journeys both passed their actual reruns.
- Profile's source/original/review/recovery/decision paths and full supporting
  source transfer are implemented. Final synthetic transfer, identity and
  recovery proofs passed; uncertain historical authority remains uncertain.
- Career's milestone boundary remains distinct from reviewed material feedback
  and authored preferences. The explicitly accepted adaptive-policy retirement
  is recorded above; the Learning/Interview/Digest journey passed its repair run.
- Application inspection, batch/standing integration and the manual-browser/
  exact-approved-email distinction are implemented. Core uncertain-send and
  real-worker-restart evidence passed without broadening submit authority.
- The hosted Browser job passed all 23 source journeys, including the demo;
  the current database-fixed installed run passed 22/22. Whole-head hosted
  CI and release-specific gates remain unfinished.

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

The findings below are historical repaired paths. Current full-run boundary
evidence passes valid-body HEAD nonmutation, and the extension journey passes a
real pending task surviving HEAD, one ordinary lease and cancellation fences.
Route-specific owner proofs retain their narrower scope; this section is not an
unresolved request to rerun the initial 98-route inventory.

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
| P1 | `features/jobs/bootstrap.py:analysis/availability`, GET+POST `/v1/jobs/{job_id}/analysis` and `/availability`; exact GET else refresh. **Bodyless HEAD availability** called `JobsService.check_availability`, external acquisition, then canonical capture or failed-attempt write. | Jobs; only POST may acquire/analyze; HEAD reads accepted state. | Owner actual-HTTP proof passed zero HEAD acquisition/model/event/revision effects and positive POST acquisition. |
| P1 | `app/http.py:settings`, GET+PATCH `/v1/settings`; HEAD with valid update JSON could validate providers and update settings. | Foundation; exact PATCH only, GET/HEAD read. | Handler fix and shared normalization are implemented; current full-run boundary/nonmutation and actual setup controls passed. |
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
| P1 — rehome implemented, owner proof reported | `features/applications/mail.py` imported old `infrastructure.gmail.auth` and `privacy`; auth imports old `config` at module scope. | `application_mail` moved explicit-path OAuth/token primitives into `mail_support.py`, with `mail_privacy.py` and `mail_windows.py`; no config defaults or global token access remain. Owner reports public CLI OAuth/atomic interruption proof on POSIX; the hosted Windows Gmail control also passed on its recorded candidate. Live user authentication remains separate. |
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

The owner subsequently reproduced an actual `Application.execute` performance
regression: the default cancellation predicate read SQLite at every admission
check. Cancellation is now polled at transition checkpoints and each achievement
while every resource-bound check remains. The same worker-path case reportedly
fell from 7.769 to 0.088 seconds, retaining exact selected IDs and accepted hash;
an actual public cancellation terminated the solve after observed database polls
without model calls. This focused repair is included in the owner's source
freeze; the earlier direct-HTTP timing alone was not treated as worker proof.

Requirements originally had a separate long-lived-catalog ceiling: 12 candidates
per page and 128 pages per attempt permitted at most **1,536 small meanings** in
a complete novelty sweep. At 1,537, a truly new requirement always failed on the
next page after 128 model comparisons. Uncommitted negative pages were discarded,
so retries could not progress. At 1,536 meanings, an admitted 100-row extraction
could need 12,800 comparison calls. Refusal was correctly fail-closed. The old
retrieval ranking also used the first extracted requirement's phrase for all
rows. The continuation and per-incoming retrieval repair below closes these
specific defects without weakening novelty authority.

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
to current install/dev entry points. The actual shared CLI journey in
`e2e-w989ac` passed after the doctor policy-snapshot repair. This is focused
completion supplemented by the 22/22 installed and hosted Browser passes;
remaining hosted jobs are separate.
Future-only CapSolver
storage is not proof of an active CAPTCHA solver, and obsolete framework
prerequisites need not return.

### Remaining behavior and acceptance gaps

No concrete unimplemented retained capability is currently identified by this
audit. The source-backed gaps raised here, including Digest CLI behavior and
full supporting-source transfer, have an implemented replacement and recorded
proof. Source-complete rows do not silently become retired features merely
because their every variant is not a standalone recurring test.

1. **Whole-head hosted acceptance:** Browser job `128139371277` passed 23/23
   on `09f9d5c`. Original PR candidate `0db` passed its other hosted contexts,
   including Backend `128144844565` and Browser `128144844490`; Windows
   credentials had failed. The corrected Windows job `128146721619` on
   `23bafd876` passed 37 controlled plus 21 native checks with cleanup, and
   Linux and macOS passed in the same focused workflow. Verify all
   required contexts against the final candidate before claiming completion.
2. **Evidence qualification:** local demo, synthetic Profile transfer, native
   lifecycle/custody and the latest pinned installed application passed; hosted
   Windows Gmail and both Darwin partitions also passed on their recorded
   candidates. The active released-upgrade harness has been rewritten for
   signed-only schema-2 exact identity; its actual operational result is tracked
   in #1428 and is required before merge. Published signed/notarized predecessor qualification, remaining
   platform controls and live-provider semantic quality remain separate. No
   hosted deployment, release or real-user reset occurred.

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
