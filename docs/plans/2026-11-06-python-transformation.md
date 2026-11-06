# JobCtrl in-place Python transformation

Accepted for implementation on 6 November 2026. Parent: https://github.com/ebarti/JobCtrl/issues/1428. Tailoring: https://github.com/ebarti/JobCtrl/issues/1255.

## Authorized outcome

Transform JobCtrl in place into a smaller Python-backed modular application with hexagonal boundaries and independently removable features. The owner explicitly authorized implementation, parallel delivery, GitHub preparation and consolidation merges on 6 November 2026. This replaces the earlier design-only approval gate. All currently implemented capabilities remain except Cover Letters, which are removed completely. Parked future backlog expansion stays parked.

### Binding decisions

- One Python authority for application actions and canonical writes, shared by HTTP, CLI and durable workers. Replace Fastify and remove the TypeScript/Python JSON-RPC hop. No forwarding bridge, mixed backend, dual writers or legacy runtime after cutover.
- One modular application, SQLite, React and existing durable execution. Plain packages, explicit composition, small ports at real I/O boundaries; no microservices, generic plugin/workflow framework or universal repository.
- Massive breaking change: preserve the **full Profile and supporting sources**, including authored baseline, evidence/source attachments, saved confirmations, preferences and provenance. Preserve uncertainty honestly. Reset all other JobCtrl-owned data at the deliberate cutover. Do not execute a real-user reset as part of development or QA.
- New tailoring is implemented on the target architecture first; all remaining capabilities are transformed before complete application cutover.
- V1 composition retains the entire approved baseline and every achievement/role, choosing exactly one approved wording per achievement. Deterministic weighted requirement coverage with stable tie-breaking; no hidden brevity penalty or silent omission.
- LLMs decide requirement meaning/equivalence, evidence support and wording coverage. Persist qualified meanings, source/version provenance and reusable IDs; retrieval narrows candidates but cannot itself decide equivalence or prove novelty. No lexical/regex heuristics or fallback.
- Fit describes the person. Wording gaps and document choices cannot lower factual qualification. A new supported requirement may propose grounded wording for explicit user approval; known requirements reuse records. Rejected/deferred proposals are not regenerated for every job.
- One simple advisory LLM coherence review of the assembled resume. Exact approval/source checks remain mechanical. The user may explicitly accept a mechanically valid document despite a review finding/timeout, with honest separate review and acceptance records.
- Baseline-copy/off mode remains available with zero resume model calls; reuse #1426/#1425.
- E2E-only target suite, started fresh. Real application/API/database/worker/renderer; controlled external LLM/job/provider boundaries. No JobCtrl internal API/domain/repository mocks, semantic heuristics or replay corpora. Static checks/builds remain. One-off profile-transfer proof is separate from recurring E2E.
- Preserve reliability: optimistic concurrency, source/revision fencing, explicit approvals, cancellation/restart recovery, last accepted artifact on failed refresh, and at-most-once external actions with honest ambiguous outcomes.
- Use synthetic owned QA state, bounded build/test concurrency, shared dependencies and task-scoped temporary cleanup. Never touch unrelated local data.

### Module ownership

| Owner | Owns |
|---|---|
| Profile | Facts, evidence, sources, confirmations, preferences, authored baseline, wording text and approval. No requirement matches or fit scores. |
| Jobs | Job identity, posting/source snapshots and manual capture. |
| Requirements | Canonical qualified requirements, occurrences, LLM equivalence decisions and catalog retrieval. |
| Fit | Person qualification, evidence support, scores/corrections and requirement-to-approved-wording relations. |
| Resumes | Deterministic variant choice, assembled documents and coverage manifest, editing, review, acceptance, locale exports and rendering. |
| Discovery / Companies | Optional search/ingestion and independent company research. Manual Jobs survives removal. |
| Contacts / Outreach | Separate contact facts and reviewed communication lifecycle. |
| Applications | Screening answers, exact-payload approval, assisted execution and outcomes. Existing capabilities only. |
| Interviews / Learning / Digest | Preparation/sessions, learning plans, and summaries/acknowledgements; learning activity never proves capability. |
| Compensation / Offers | Reusable neutral compensation core and separate offer terms/decisions. Prepare a clean future extraction boundary, not a new library release now. |

Dashboard, Activity, Settings and Evidence Map compose public feature panels/queries. The shell owns layout/navigation and one event connection; feature modules own their data, commands and invalidation. No sibling private-table access or alternate business writer.

### Delivery and evidence

Parallel workstream issues are linked below. They may build independently against agreed public contracts; shared foundation and final integration have one owner. A feature is complete only when reachable through the actual application, with its retained capability inventory reconciled and E2E/product proof on the integrated candidate. Moving files, adding unused packages or leaving legacy entry points active does not satisfy this issue.

The coordinator may consolidate through verified PRs under the owner's authorization. No release/deployment or real profile reset is authorized by this development request. Do not close a child from an early partial PR. Keep exact candidate/check results and remaining gaps visible.

### Existing backlog reconciliation

- #1255 remains the tailoring design/intelligence owner and is updated to this accepted direction.
- #1425 / PR #1426 supplies baseline-copy behavior; reuse its implementation, do not declare it merged before GitHub confirms.
- #1158 applies to preparing grounded reusable wording; per-job writing/polish loops are superseded.
- #1421 measures ready composition after wording approval; human approval wait and cold preparation are separate, and no performance result is assumed.
- #954 / PR #1114 RPC-specific work becomes obsolete when the RPC layer is actually retired. Preserve the useful contract ownership intent.
- #908 full-document AI comparison is retired with delivery of simplified tailoring; no additional required review stage.
- #1002, #1004, #1006–#1009 contain delivered work to reuse, not outstanding tasks to redo.
- #1124 remains the broader product simplification outcome; #1135 remains useful installed-reliability evidence, adapted to the fresh-state/E2E-only contract.
- #1265 / PR #1266 remains parked and is not a prerequisite.
- Future Applications/follow-through expansion remains parked: #1128, #1032, #1029, #1195, #1040, #1034, #1018.

## Workstreams

- [ ] #1429 — establish Python feature contracts and the sole HTTP application. Integration prerequisites: none.
- [ ] #1430 — own full career evidence and approved wording independently. Integration prerequisites: #1429.
- [ ] #1431 — isolate Jobs Discovery and Companies with Python ownership. Integration prerequisites: #1429.
- [ ] #1432 — persist LLM-resolved reusable requirement identities. Integration prerequisites: #1429, #1431.
- [ ] #1433 — share person qualification and approved-wording coverage intelligence. Integration prerequisites: #1429, #1430, #1432.
- [ ] #1434 — compose complete approved baselines deterministically. Integration prerequisites: #1429, #1430, #1432, #1433.
- [ ] #1435 — separate contact facts from reviewed communication actions. Integration prerequisites: #1429, #1430, #1431.
- [ ] #1436 — move existing approved application actions into Python. Integration prerequisites: #1429, #1430, #1431, #1434.
- [ ] #1437 — isolate Interviews Learning and Digest capabilities. Integration prerequisites: #1429, #1430, #1431, #1433.
- [ ] #1438 — extract a neutral core and separate offer decisions. Integration prerequisites: #1429, #1431, #1430.
- [ ] #1439 — compose feature-owned pages queries and event handling. Integration prerequisites: #1429.
- [ ] #1440 — expose profile requirement fit and resume approval workflows. Integration prerequisites: #1429, #1430, #1432, #1433, #1434, #1439.
- [ ] #1441 — reconnect retained optional features to independent owners. Integration prerequisites: #1429, #1439, #1431, #1435, #1436, #1437, #1438.
- [ ] #1442 — cut over CLI packaging extension and launch to Python. Integration prerequisites: #1429, #1434.
- [ ] #1443 — replace legacy suites with fast complete application journeys. Integration prerequisites: #1429, #1439, #1442.
- [ ] #1444 — remove Cover Letters and reconcile product documentation. Integration prerequisites: none.

All sixteen workstreams may begin inventory, design and owned implementation immediately. Shared-contract integration follows the dependencies above. Final consolidation owns complete capability reconciliation, removal of legacy runtime paths and end-to-end acceptance.

## Local coordination contract

- Dedicated branch: `feat/1428-python-transformation`, starting at `9f6f318a86f103f6fdfd0c4aab41d7d26917b2e7`.
- One shared task checkout and installed dependency set; **you are not alone**. Preserve other workers' edits and unrelated `.local/` data. Do not create additional clones/worktrees, install duplicate dependencies, stage/commit/reset/rebase, or change branch. The coordinator owns integration commits and GitHub PRs/merges.
- Target feature packages: `workers/automation/src/jobctrl/features/<owner>/`. Each feature owns its domain/application, actual I/O ports/adapters, schema and public data/actions. No sibling-private-table access, wrapper-only facade or shared generic business repository. Existing code may be moved/reused where its boundary is sound; legacy active entry points must disappear before final acceptance.
- The foundation owner freezes minimal interface/bootstrap/HTTP contracts in `docs/plans/2026-11-06-python-contracts.md` and messages affected workers immediately. Start source inventory and independent implementation now; coordinate cross-owner signatures before wiring.
- Root owns this plan, integration records and GitHub. Foundation owns shared Python runtime/server/bootstrap/dependencies; runtime owner coordinates launcher/CLI/packaging changes; E2E owner owns target tests/CI test routing. Feature owners do not edit those shared files unilaterally.
- Web shell owns shared navigation/transport/query/SSE/lint contracts. Web core owns Profile/Jobs/Requirements/Fit/Resumes UI; web optional owns remaining feature UI. Agree exact existing paths before editing shared views.
- Cover/docs owns Cover-only production assets and product/user documentation; send cross-feature deletions to the owning worker. E2E owns deletion of old tests. Foundation owns architecture/runtime contracts and web shell owns frontend architecture docs; coordinate other documentation before editing.
- All agents use max reasoning; Terra for bounded mechanical/UI/docs tasks, Sol for feature implementation, Astra for architecture and adversarial review. Do not launch additional agents or parallel heavy builds without coordinator agreement.
- Share existing dependencies. Heavy builds and full-stack E2E are centrally scheduled. Small compile/lint checks on owned files are fine. Use only task-owned synthetic state. No real profile, applications, email, credentials, or private generated documents in QA or commits.
- Initial disk observation: approximately 155 GiB available, checkout 4.3 GiB including existing dependencies and unrelated `.local/`. New temporary resources belong under `/private/tmp/jobctrl-transform-1428/` or an explicitly recorded task path. Avoid artifact duplication and bound logs. Coordinator records usage and removes only owned disposable resources after evidence is retained.
- User authorized consolidation merges for this transformation. Required checks and integrated behavior still need evidence. No release/deployment/live-user reset is included.

| Workstream | Issue | Integration prerequisites |
|---|---|---|
| foundation | [#1429](https://github.com/ebarti/JobCtrl/issues/1429) | none |
| profile | [#1430](https://github.com/ebarti/JobCtrl/issues/1430) | foundation |
| jobs_discovery | [#1431](https://github.com/ebarti/JobCtrl/issues/1431) | foundation |
| requirements | [#1432](https://github.com/ebarti/JobCtrl/issues/1432) | foundation, jobs_discovery |
| fit | [#1433](https://github.com/ebarti/JobCtrl/issues/1433) | foundation, profile, requirements |
| resumes | [#1434](https://github.com/ebarti/JobCtrl/issues/1434) | foundation, profile, requirements, fit |
| contacts_outreach | [#1435](https://github.com/ebarti/JobCtrl/issues/1435) | foundation, profile, jobs_discovery |
| applications | [#1436](https://github.com/ebarti/JobCtrl/issues/1436) | foundation, profile, jobs_discovery, resumes |
| career | [#1437](https://github.com/ebarti/JobCtrl/issues/1437) | foundation, profile, jobs_discovery, fit |
| compensation | [#1438](https://github.com/ebarti/JobCtrl/issues/1438) | foundation, jobs_discovery, profile |
| web_shell | [#1439](https://github.com/ebarti/JobCtrl/issues/1439) | foundation |
| web_core | [#1440](https://github.com/ebarti/JobCtrl/issues/1440) | foundation, profile, requirements, fit, resumes, web_shell |
| web_optional | [#1441](https://github.com/ebarti/JobCtrl/issues/1441) | foundation, web_shell, jobs_discovery, contacts_outreach, applications, career, compensation |
| runtime | [#1442](https://github.com/ebarti/JobCtrl/issues/1442) | foundation, resumes |
| e2e | [#1443](https://github.com/ebarti/JobCtrl/issues/1443) | foundation, web_shell, runtime |
| cover_docs | [#1444](https://github.com/ebarti/JobCtrl/issues/1444) | none |

