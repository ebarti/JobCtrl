# Original app redesign

Status: implemented, source-qualified candidate. This
plan covers the whole application, documentation and offline demo. It records
the bounded source qualification below; deployment, release and participant
acceptance remain separate. The [UI candidate](https://github.com/ebarti/JobCtrl/pull/1467) is
stacked above [PR #1465](https://github.com/ebarti/JobCtrl/pull/1465), whose bounded
matching work remains a separate dependency.

## Scope and source of truth

Deliver the selected Original visual direction across **Jobs, My profile and
Settings**, including their contextual workspaces and independently useful
resources. Use the latest owner corrections in
[#1124](https://github.com/ebarti/JobCtrl/issues/1124),
[#1125](https://github.com/ebarti/JobCtrl/issues/1125),
[#1126](https://github.com/ebarti/JobCtrl/issues/1126),
[#1127](https://github.com/ebarti/JobCtrl/issues/1127),
[#1129](https://github.com/ebarti/JobCtrl/issues/1129) and
[#1136](https://github.com/ebarti/JobCtrl/issues/1136). Newer corrections supersede
the earlier mode proposal and private-prototype details. There is one streamlined
application and one current review candidate.

The 11 November owner correction further constrains maintained wording: an
achievement linked only to one requirement has one current wording. An edit is
a proposed revision with retained history. Additional maintained wording needs
distinct requirement coverage that cannot reuse or consolidate the current
wording; labels name those canonical requirements, not editorial focus or an
arbitrary alternative number. Exact earlier approvals and accepted materials
remain intact. This supersedes the earlier private-preview alternative-card
contract. The correction is implemented in the current source candidate;
combined and affected verification results are recorded
below.

Retain feature-owned API, storage, model authority and durable execution. A
navigation change does not retire a business capability, delete records, enable
a source or launch work. Use `resume` in English copy. Private prototype content
and previous source-build evidence are not production acceptance for this change.

The later Jobs correction makes **Start search** a direct action on the comparison
workspace, using confirmed saved preferences. A compact inline progress strip
shows canonical lifecycle/counts and exact-run stop/recovery. Editing criteria is
secondary **Search preferences** navigation; progress and duplicate-start guards
survive navigation and reload. No automatic search is admitted by these reads.

## Whole-product acceptance ledger

`Verified` means the changed flow passed the source-built application journeys
and the applicable rendered checks described below, using owned synthetic state
and controlled external services on `88e97a53d`, with any subsequent affected
proof identified separately. It does not qualify every
historical capability named in the acceptance boundary. Retained/source-readback
scope and exclusions are explicit below. Materials has its own affected proof;
hosted verification is tracked in the PR checks. A passing page-width check
alone does not close visual acceptance.

| ID | Retained outcome and target home | Acceptance boundary | State |
| --- | --- | --- | --- |
| O01 | Jobs comparison is the daily workspace | Table retains search, filters, sort, pagination, saved views, columns and supported selection/bulk actions. Pay units/currency, fit, freshness and application state remain comparable; unknowns stay unknown. Empty workspace differs from filtered zero. | Verified changed Jobs flows and comparison at the tested widths. |
| O02 | Job workspace beside the comparison context | Overview/fit, resume, review/application, people, interviews and history stay attached to the exact job. Return from details and full-size Plate restores query/order/page/selection/scroll and drafts, including supported deep links. | Verified exercised return/context/draft paths; inherited job tools retained. |
| O03 | One bounded Prepare resume action | The explicit tailored/full-baseline choice uses existing preparation stages, readiness, limits, validation and rendering. Real progress, cancel and same-request recovery stay with the job. Navigation and ordinary saves launch nothing. | Verified bounded preparation, admission and recovery. |
| O04 | Actual Plate editors and accepted materials | Baseline, template preview and job resume use the existing editable Plate implementation. Preserve formatting, source mapping, drafts, full authored baseline, exact review, PDF/DOCX, locales and accepted history. Inspect actual export bytes; failed refresh/render preserves the accepted version. | Verified actual Plate/PDF paths; DOCX/locales retained by source readback. |
| O05 | Reviewed application and outcome loop | Exact current packet, rehearsal/approval, browser handoff, screening answers, manual outcomes, email suggestions, offers and feedback remain reachable from the job. External effects retain their existing permission and uncertainty rules. | Verified review/recovery with controlled external services; live effects excluded. |
| O06 | Peer My profile sections | Experience, Skills, Education and Personal details sit alongside Resume, Learning and Search preferences. Job-independent Interview library stays explicitly reachable from Jobs. Open on Experience; remove redundant Overview. Preserve independent fields, stable IDs, summaries, autosave, conflicts and saved-state/non-secret recovery persistence. Secret edits remain session-only with a reload/close guard; recovery cannot overwrite peer-tab or accepted work. | Verified peer edits, non-secret recovery and concurrency. |
| O07 | Role and achievement lifecycle | Add/edit/remove/restore roles and achievements with position summaries, drafts, sources, decisions and links restored together. Removal or profile editing cannot silently rewrite accepted documents. | Verified role/achievement CRUD and original-ID restoration. |
| O08 | Requirement-led current wording, proposed revisions and history under each achievement | A single linked requirement has one maintained current wording. Edits create proposed revisions and retain the exact approved text/history. Additional maintained wording requires distinct requirement coverage that cannot reuse or consolidate existing wording. Canonical requirement names label the wording; per-revision exact approve/reject/defer, provenance, comparison and recovery remain. No global preferred/selected wording is introduced. | Verified maintained wording, separate proposals/history and exact revision fences. |
| O09 | Canonical achievement tags and standalone Requirements library | Click a reusable qualified requirement to inspect definition/scope/qualifiers/version, linked achievements, their wordings and source occurrences. Support many-to-many relations, exact return context and revision-aware staleness. Manual associations remain unassessed and cannot imply factual support, textual coverage, qualification or score. | Verified library, canonical links, association history and return context. |
| O10 | Manual matching refresh, inherited from #1464 / #1465 | Saves and approvals make zero automatic model calls. Explicit Update affected matches admits fixed bounded work with full-catalog authority, grouped wording gaps, reuse/consolidation before additional wording, cancellation, deduplication and accepted-state preservation. The maintained-wording correction does not itself change resume occurrence/cardinality. | Verified bounded manual refresh, grouped choices and assignment races. |
| O11 | Connected Search preferences and explicit launch | Jobs distinguishes Filter saved jobs from Search for jobs → Start search. Show effective saved roles/locations/work models, source/limit scope and true readiness. Preferences and Connections return to that task without launching. Real search progress/results/stop/recovery retain exact identities. | Verified saved-criteria launch/handoff with controlled providers. |
| O12 | Readable saved search authoring and places | Repeatable role inputs support Enter/focus; career tracks use explicit selections; responsive sections use the available width. Real place selection binds identity/coordinates and later text edits invalidate that binding. Autosave/reload and blocked saves are visible. | Verified input/save/place-binding behavior with controlled Photon. |
| O13 | Settings appearance | Default Graphite + Geist, ten color choices and ten actual font resources apply coherently across the app and persist. Review density, type hierarchy, focus, hover and narrow layouts. App appearance does not change resume rendering. | Verified all choices/resources and Plate isolation; visual sampling described below. |
| O14 | Shared Settings and diagnostics | Connections/credentials, provider/model choices, budgets, automation and Data & diagnostics remain discoverable. Saved/effective/unknown state is truthful; normal forms do not demand worker, lane or queue supervision. | Verified forms/readiness with controlled providers; diagnostic capabilities retained. |
| O15 | Independent retained capabilities | People/contact notes/outreach drafts, job-independent Practice and interview library, Learning/career evidence, requirement/source inspection, compensation/offers, source controls, schedules, screening answers, locale/template/history and supported CLI/extension workflows retain explicit reachable homes. Optional/unmounted capability is honestly unavailable. | Verified changed Materials search and exercised independent routes/journeys; inherited limits below. |
| O16 | Offline demo and owning documentation | Demo uses the same whole-product hierarchy with synthetic state and truthful local/simulated/unavailable boundaries. Update daily flow, tour, setup/profile/search/material/application/configuration guides, API and architecture owners to actual controls; source candidate never implies hosted deployment. | Verified demo/docs behavior; final image rebuild recorded below and hosted checks tracked in the PR. |

## Intentional destination removals, retained outcomes

| Former ordinary destination | Outcome in the target |
| --- | --- |
| Dashboard / Today | Compact actionable attention within Jobs; no empty metric landing page. |
| Pipelines and stage-by-stage Enrich / Analyse / Score / Tailor | Goal-based search/preparation with task-local progress, stop and recovery. |
| Runs / Activity | Task history plus Settings → Data & diagnostics for deliberate technical inspection; receipts/events remain authoritative. |
| Discovery | Jobs search surface and connected Search preferences; contextual source controls remain. |
| Artifacts / standalone Apply review | Selected job resume, accepted versions, reviewed packet and outcome; cross-job list/filter remains discoverable. |
| Analytics | Honest outcome summary reachable from Jobs, with unknown/sample limitations. |
| Evidence Map / separate wording navigation | Source and exact wording decisions next to the achievement/requirement; Requirements has an independent library entry. |
| Preferences / detached template settings | Search preferences at the task and editor-local template/style controls. |
| Contacts / Interviews as primary rail entries | Contacts and Interview library stay reachable from Jobs without requiring a selected job; contextual people and interview preparation remain attached to the job. |

This changes information architecture, not stored-record ownership. Source
authoring, continuous/batch apply, outreach expansion and career/market
administration are not silently retired. Earlier retirement proposals require
their own explicit outcome and data decision. Cover Letters remain excluded by
the already accepted Python transformation; this redesign does not reopen them.

## Delivery and proof

1. Map existing routes, independent capabilities, states and return paths; carry
   baseline defects and accepted-artifact rules into the integrated target.
2. Implement coherent job, profile, search, settings and demo slices using the
   shared Original tokens and existing public feature interfaces. Update each
   owning document as its actual contract is confirmed.
3. Run applicable static checks and the affected real Python application
   journeys under [Reliability and QA](../local-reliability-qa.md). Use fresh owned
   synthetic workspaces and real controlled external boundaries; no private
   Profile, provider spend, submission or message send is admitted by QA.
4. Review task coherence, behavioral fidelity and visual craft separately at
   wide/ordinary/narrow widths. Exercise ordinary navigation, reload/back/return,
   empty/loading/error/recovery, keyboard/focus, multiple appearances and both
   real Plate surfaces. Repair material findings and recheck affected paths.
5. Record exact candidate, commands, timings, observed canonical state and
   limitations. Full-suite, operational/provider, human-usability, accessibility,
   merge, release and deployment evidence remain distinct.

## Observed verification

The source-built `corepack pnpm e2e` run on committed candidate `88e97a53d`
passed **57/57**, with zero retries, skips, flaky cases or global errors, in
`e2e-0S91Lx`. It recorded a 7.782-second web build, 441.372 seconds of journey
orchestration and 450.971 seconds total. Dependency locks and built web assets
were unchanged during the run. The [owning QA record](../developer/qa/python-journeys.md#source-qualification-on-88e97a53d)
records exact Python, capability-policy and web hashes, runner identity and the
unchanged caps. This is source-candidate qualification, not an installed or
deployed result.

The whole-product surface case passed in 26.4 seconds: 26 surfaces at 1440 ×
1000, 1860 × 1227, 2943 × 1227 and 390 × 844 produced 104 settled viewport
captures, with extra full-height Profile/Requirements captures. Actual loaded or
explicit-empty content, fonts, active navigation, link sizing/padding and page
width passed. Those checks are distinct from image inspection. The first
passing inventory had missed a narrow inner Profile wording grid; owning layout
repairs and fresh ordinary/wide/mobile Profile inspection now show readable
full-width requirement/wording rows, separate proposals/history and wrapping
controls. Actual selected-month controls were also inspected at 1440 and 390.

Coordinator review covered all 26 retained surfaces at 1440 and selected 2943
and 390 task views. It led to repairs for duplicate breadcrumbs, excessive
borders/bold values, Profile secondary-tool placement/skill density/role-button
overlap, job-title focus clipping, mobile comparison order/header density,
default table columns, raw requirement labels and Materials/Applications copy.
Final reviewed docs images match `e2e-0S91Lx`; current and proposed wording are
distinct. The coordinator also inspected the actual `export-1bb2754c` PDF raster:
legible and unclipped. Transient loading images were not accepted.

**Materials mobile finding repaired and verified.** Inspection after the
57/57 run found a 24-pixel search input and clipped button at 390 despite the
page-width pass. The bounded class/CSS repair in `fcf9e7f09` and stronger existing-case checks
cover real search, clear, retained state and control geometry. The affected
proof below closes that finding; the earlier automated 57/57 alone had not
established complete visual acceptance.

The first affected run, `e2e-fGjTmn` on `fcf9e7f09`, passed production
baseline/export and demo Plate/PDF but failed the matrix case: **2/3 passed**.
Actual Materials search/clear/filter and geometry passed before an unscoped
`Accepted` assertion matched the native option and mobile/hidden-desktop badges.
The harness now reads the visible list and exact select value. This is an
assertion-scope correction with no further production change.

The final matrix command on `8a917b23f`, `e2e-imUbCE`, passed **1/1** with all
104 frames and the actual Materials search/clear/status/geometry checks. Its
body took 25.4 seconds; build, journey orchestration and total were 7.592,
30.975 and 40.251 seconds, with zero retries, skips or global errors. The web
bundle SHA-256
`b1365861bcdb3983eafba5c7949de7be6d47faaf31741db8708dc7c01f24dabf`
matches the earlier affected production baseline/export and demo Plate/PDF
passes. The three affected cases therefore have passing observations across
two commands; this is not a claim that all 57 were rerun on the final head.
Hosted exact-head qualification is recorded in the PR checks.

Independent `ps`/`lsof` and owned-path checks corroborated runtime cleanup for
the combined and affected runs. Successful workspaces/homes were removed;
the failed `e2e-fGjTmn` selector attempt retains one owned synthetic workspace,
home and Temporal history for diagnosis, with no live process or listener.

The ledger's inherited scope is deliberately narrower than a new qualification
of every historical capability:

- O04 has actual editable Plate, baseline/job document, rendered PDF,
  preview/download and accepted-byte preservation proof. DOCX and locale
  capabilities are retained through source readback; this run does not contain
  a DOCX/locale export journey.
- O05 and O15 include actual reviewed application/recovery and retained optional
  journeys for manual outreach attestation, interview notes/preparation,
  Learning activity, offers/corrections, confirmed contact research, controlled
  Discovery/company briefing and compensation evidence. External services are
  controlled; no real employer submission, live message send or paid-provider
  compatibility is qualified.
- CLI/extension/native distribution and standing source/automation capabilities
  keep their existing public contracts and reachable controls. This UI work
  does not establish a new installed-native, release-signing or operational
  qualification of all those workflows.
- Agent image review and browser assertions are not participant research or a
  full accessibility audit. Earlier private prototype screenshots, historical
  transformations, route counts and builds do not substitute for the observations
  above. Merge, release and deployment remain separate evidence.

The first combined 57-case run, `e2e-3003zl` on `8fef91a6c`, completed
**55 passed / 2 failed**. One failure was an obsolete Jobs-filter selector in
the harness; the other was actual mobile Applications overflow introduced by
the managed-preparation wrapper. The 897-pixel layout did not fit the 390-pixel
viewport. That first combined run is not a green suite. The repairs are now
included in committed candidate `88e97a53d`, whose combined 57/57 result is
recorded above.
The first run's settled Profile/Resume images passed their per-surface checks
and were inspected independently, while the failed mobile Applications capture
was excluded from the published guides.

Targeted application run `6x4eyt` passed the repaired Profile
concurrency/recovery journey in 6.44 seconds, the Profile CRUD/wording
Restore–Discard–Undo/save/approval/stable-ID restoration journey in 5.34 seconds,
and the mobile Applications baseline-preparation journey in 8 seconds. That
last journey checked the exact produced document, retained accepted PDF hash
and dirty-Plate navigation protection. Grouped exact pins, the concurrent
assignment-change refusal, requirement return and lost-admission recovery also
passed their targeted observations. These focused results do not qualify all
57 journeys. The more specific wording schedules with a held Save or Restore
across remount, and reload during a queued Undo write, received source review
but were not forced in the browser.

The final demo target exposed an actual post-broadcast-reset autosave failure
after its core editing/export checks passed. The owning reset-boundary repair
was included in local production commit `8fef91a6c`. Target `aE6Wtl` then passed
the full demo case in 28.6 seconds: actual PDF preview/download hashes, dirty
two-tab reset, canonical/DOM/reload persistence after post-reset autosave,
absence of stale wording/reload guards, clean-seed recomposition and retained
consent/privacy boundaries. The Jobs search-handoff/custom-view/mobile target
also passed in 6.4 seconds. These repairs and focused passes remain distinct
from the later complete 57-case qualification above. The
[journey inventory](../developer/qa/python-journeys.md) records the nine added
cases and unchanged limits separately from observed qualification.

The documentation build passed in the working candidate with
`corepack pnpm docs:build`: the latest VitePress build completed in 7.69 seconds,
the install asset matched, 16,169 references resolved across 473 emitted files,
and installer/legacy-tour redirect checks passed. The first build exposed one
documentation-home link to a repository-only plan route; the standard source
link repaired it before a passing 7.33-second rerun. Later builds include the
synthetic captures and actual shared font resources. The final-image build
also caught two full-height Profile links whose plain Markdown asset was not
emitted. The linked capture was moved to the public-asset owner and both links
were corrected before the same gate passed.

`corepack pnpm docs:check:runtime` passed with the new guide/media paths against
its own fresh loopback preview. The final same-size capture refresh was
inspected manually and included in the build above. The rendered gate checked
the new Requirements guide, image loading/zoom, tour media
and outline at desktop/narrow widths, keyboard navigation, shared light/dark
Graphite at 1440/390, actual loaded Geist WOFF2 resources, text/control/focus
contrast, the web/CLI workflow selector, search and consent/privacy behavior.
The first rendered run recorded 22 failures: tour image paragraph structure and
missing default font resources were actual defects; hierarchy/Discovery and old
palette/type/geometry expectations also needed the accepted contract update.
The markup and shared typeface import were repaired at their owners. The updated
gate preserves functional/integrity checks and verifies the new computed tokens,
font resources, contrast and focus rather than accepting a font-family label.

The documentation checks qualify the guide build and browser behavior.
Application source qualification and inherited limits are recorded separately
above. Participant, full accessibility, installed-runtime, release and deployment
acceptance remain outside this proof. Hosted verification of the final delivery
head lives in the [PR checks](https://github.com/ebarti/JobCtrl/pull/1467/checks),
with delivery status read back in the owning issues.

## Hosted scheduling follow-up

[CI run 43031016511](https://github.com/ebarti/JobCtrl/actions/runs/43031016511)
on documentation delivery `79bf88b814ec34d546418fa784833aba21b5c78c` passed ten
other jobs, while its Browser job reached the unchanged 720-second global
deadline after all 56 application cases passed. The demo did not complete;
there were no individual case failures, and the complete hosted result is
nonpassing. Build, journey orchestration and total were 18.534, 721.079 and
744.757 seconds on Linux x64 / four CPUs / Node 22.21.1. The unchanged final web
bundle does not turn this timeout into complete coverage.

CI now schedules two standard disjoint Playwright shards, with one worker,
zero retries and the same case/global deadlines per invocation. Fail-fast is
disabled; the stable **Browser / UI checks** aggregate requires both shards to
succeed and each retains unique evidence. The [owning QA record](../developer/qa/python-journeys.md#hosted-scheduling-follow-up)
documents the mechanics and observed failure. Native test listing measured
35 cases in 13 files and 22 cases in 12 files, including the demo: their union
is exactly all 57 cases in 25 files, with no overlap, missing cases or extras.
This validates the partition inventory, not hosted execution. At this record, hosted
qualification is pending; final results are tracked in the
[PR checks](https://github.com/ebarti/JobCtrl/pull/1467/checks). The earlier local
57/57 and final affected proof retain their original candidates and scope.

The documentation follow-through passed `corepack pnpm docs:build` in 7.51
seconds: 16,171 references resolved across 473 emitted files, with install-asset
and redirect checks passing. Whitespace checks passed.

### Direct Jobs search follow-through

The final Jobs entry directly starts saved criteria and renders inline progress,
counts and exact stop/recovery. New admissions serialize across tabs and remain
bound to the criteria's database incarnation. Eight distinct affected journeys
passed across the final focused source runs, including the full 104-capture
matrix and offline demo. Earlier failures and the corrected cancellation race
remain in the [QA ledger](../developer/qa/python-journeys.md#direct-jobs-search-and-inline-progress-11-november-2026).
Full qualification of the new 60-case inventory belongs to the pushed PR checks;
this does not imply merge, deployment or release.
