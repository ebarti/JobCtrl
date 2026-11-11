# Original app redesign

Status: active, authorized implementation candidate. This plan covers the whole
application, documentation and offline demo. It does not establish a deployment,
release, participant acceptance or passing verification. The UI candidate is
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

Retain feature-owned API, storage, model authority and durable execution. A
navigation change does not retire a business capability, delete records, enable
a source or launch work. Use `resume` in English copy. Private prototype content
and previous source-build evidence are not production acceptance for this change.

## Whole-product acceptance ledger

`Pending` means the outcome still needs implementation readback and actual
verification. A rendered shell, source-complete adapter or passing build alone
cannot close a row. Record observed results against the exact candidate below.

| ID | Retained outcome and target home | Acceptance boundary | State |
| --- | --- | --- | --- |
| O01 | Jobs comparison is the daily workspace | Table retains search, filters, sort, pagination, saved views, columns and supported selection/bulk actions. Pay units/currency, fit, freshness and application state remain comparable; unknowns stay unknown. Empty workspace differs from filtered zero. | Pending |
| O02 | Job workspace beside the comparison context | Overview/fit, resume, review/application, people, interviews and history stay attached to the exact job. Return from details and full-size Plate restores query/order/page/selection/scroll and drafts, including supported deep links. | Pending |
| O03 | One bounded Prepare resume action | The explicit tailored/full-baseline choice uses existing preparation stages, readiness, limits, validation and rendering. Real progress, cancel and same-request recovery stay with the job. Navigation and ordinary saves launch nothing. | Pending |
| O04 | Actual Plate editors and accepted materials | Baseline, template preview and job resume use the existing editable Plate implementation. Preserve formatting, source mapping, drafts, full authored baseline, exact review, PDF/DOCX, locales and accepted history. Inspect actual export bytes; failed refresh/render preserves the accepted version. | Pending |
| O05 | Reviewed application and outcome loop | Exact current packet, rehearsal/approval, browser handoff, screening answers, manual outcomes, email suggestions, offers and feedback remain reachable from the job. External effects retain their existing permission and uncertainty rules. | Pending |
| O06 | Peer My profile sections | Experience, Skills, Education and Personal details sit alongside Resume, Learning, Practice and Search preferences. Open on Experience; remove redundant Overview. Preserve independent fields, stable identities, summaries, autosave, conflicts and navigation/reload persistence. | Pending |
| O07 | Role and achievement lifecycle | Add/edit/remove/restore roles and achievements with position summaries, drafts, sources, decisions and links restored together. Removal or profile editing cannot silently rewrite accepted documents. | Pending |
| O08 | Complete wording alternatives under each achievement | Each wording has its own label, exact text, editing, approve/reject/defer, provenance, comparison and recovery. Editing approved text creates a draft while retaining approval history. No global preferred/selected wording is introduced. | Pending |
| O09 | Canonical achievement tags and standalone Requirements library | Click a reusable qualified requirement to inspect definition/scope/qualifiers/version, linked achievements, their wordings and source occurrences. Support many-to-many relations, exact return context and revision-aware staleness. Manual associations remain unassessed and cannot imply factual support, textual coverage, qualification or score. | Pending |
| O10 | Manual matching refresh, inherited from #1464 / #1465 | Saves and approvals make zero automatic model calls. Explicit Update affected matches admits fixed bounded work with full-catalog authority, grouped wording gaps, cancellation, deduplication and accepted-state preservation. Resume occurrence/cardinality policy is unchanged by this UI work. | Pending |
| O11 | Connected Search preferences and explicit launch | Jobs distinguishes Filter saved jobs from Search for jobs → Start search. Show effective saved roles/locations/work models, source/limit scope and true readiness. Preferences and Connections return to that task without launching. Real search progress/results/stop/recovery retain exact identities. | Pending |
| O12 | Readable saved search authoring and places | Repeatable role inputs support Enter/focus; career tracks use explicit selections; responsive sections use the available width. Real place selection binds identity/coordinates and later text edits invalidate that binding. Autosave/reload and blocked saves are visible. | Pending |
| O13 | Settings appearance | Default Graphite + Geist, ten color choices and ten actual font resources apply coherently across the app and persist. Review density, type hierarchy, focus, hover and narrow layouts. App appearance does not change resume rendering. | Pending |
| O14 | Shared Settings and diagnostics | Connections/credentials, provider/model choices, budgets, automation, data controls and Help → Diagnostics remain discoverable. Saved/effective/unknown state is truthful; normal forms do not demand worker, lane or queue supervision. | Pending |
| O15 | Independent retained capabilities | People/contact notes/outreach drafts, job-independent Practice and interview library, Learning/career evidence, requirement/source inspection, compensation/offers, source controls, schedules, screening answers, locale/template/history and supported CLI/extension workflows retain explicit reachable homes. Optional/unmounted capability is honestly unavailable. | Pending |
| O16 | Offline demo and owning documentation | Demo uses the same whole-product hierarchy with synthetic state and truthful local/simulated/unavailable boundaries. Update daily flow, tour, setup/profile/search/material/application/configuration guides, API and architecture owners to actual controls; source candidate never implies hosted deployment. | Pending |

## Intentional destination removals, retained outcomes

| Former ordinary destination | Outcome in the target |
| --- | --- |
| Dashboard / Today | Compact actionable attention within Jobs; no empty metric landing page. |
| Pipelines and stage-by-stage Enrich / Analyse / Score / Tailor | Goal-based search/preparation with task-local progress, stop and recovery. |
| Runs / Activity | Task history plus Help → Diagnostics for deliberate technical inspection; receipts/events remain authoritative. |
| Discovery | Jobs search surface and connected Search preferences; contextual source controls remain. |
| Artifacts / standalone Apply review | Selected job resume, accepted versions, reviewed packet and outcome; cross-job list/filter remains discoverable. |
| Analytics | Honest outcome summary reachable from Jobs, with unknown/sample limitations. |
| Evidence Map / separate wording navigation | Source and exact wording decisions next to the achievement/requirement; Requirements has an independent library entry. |
| Preferences / detached template settings | Search preferences at the task and editor-local template/style controls. |
| Contacts / Interviews as primary rail entries | People from Jobs without requiring a selected job; contextual contacts/interviews and independent My profile Practice/library. |

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

No redesign result is recorded as passing yet. Implementation readback, static
checks, application/demo journeys, document export inspection, rendered visual
review and final candidate identity are pending. Earlier prototype screenshots,
route counts and historical transformation runs do not close this ledger.
