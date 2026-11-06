# Transformation workstream assignments

Read [the accepted plan](2026-11-06-python-transformation.md) first. Shared checkout: preserve every other worker's changes. Coordinate through the root agent; no worker git commits or dependency installations.

## foundation — #1429

Own the target package layout, explicit composition root, shared runtime adapters, Python HTTP server, security boundary, feature route registration, durable application dispatch and single canonical SQLite transaction/event mechanics. Freeze a concise public interface contract first so feature teams can work in parallel. Replace Fastify/JSON-RPC at final integration rather than wrapping legacy business handlers. Port host/origin/peer/token protections, SSE, settings/credentials/health and static serving. Keep domain/application code independent of HTTP/SQLite/Temporal SDKs; keep infrastructure small. Coordinate package dependencies and database bootstrap with feature-owned schema.

Acceptance: Boot the real Python API and worker; exercise authorized and rejected requests, committed SSE visibility, concurrency conflicts, health/configuration, and durable execution through public entry points. All target features register explicitly and cannot read sibling private tables.

Integration prerequisites: none.

## profile — #1430

Own the Profile feature: career facts, authored baseline, source attachments, confirmations/provenance, profile preferences and exact wording proposals/approval/rejection. No Fit/Requirements private imports or requirement match lists in Profile. Accept an immutable authoring brief through a port; Profile functions without Fit. Implement full-profile export/import for the one-off fresh-state transition without preserving non-profile records or inventing historic confirmation authority. Preserve existing profile editing, evidence and coaching capabilities under this owner.

Acceptance: Real application journeys create/edit/import profile, inspect sources, approve and reject variants, reject stale saves and preserve prior accepted versions on failed authoring. Supply one-off synthetic old-to-new profile integrity proof outside regular E2E.

Integration prerequisites: foundation.

## jobs_discovery — #1431

Own Jobs, Discovery and Companies as separate removable feature packages. Preserve manual capture, job identity/source snapshots, search targets/providers/schedules, ingestion controls and company research/briefings. Port actual existing behavior, including JobStreaming integration, rather than adding unused wrappers. Jobs works without automatic Discovery or Companies. Expose immutable posting/company snapshots; requirements and fit remain other owners. Preserve source policies, literal user filters and recorded semantic authority.

Acceptance: Real manual capture/refresh and controlled-external search journeys, source provenance, duplicate/racing capture safety, schedule changes, cancellation/restart and Companies-off behavior. Reconcile current capability inventory.

Integration prerequisites: foundation.

## requirements — #1432

Own Requirements catalog, qualified meanings, source occurrences/spans, revisions and retrieval/index freshness. LLMs extract and decide equivalence/novelty using source-bound output and lane/spend preflight; retrieval is candidate selection only, never semantic authority. Top-k miss alone cannot prove novelty. Reconcile concurrent discoveries, corrected bindings and stale source versions. No lexical/regex semantic fallback, unbounded catalog prompts, or duplicated new meanings for paraphrases.

Acceptance: E2E controlled external model responses demonstrate paraphrase reuse, qualified distinctions, truly new requirements, unsupported/invalid output, concurrent identical discovery and stale-source rejection; persist provenance and preserve accepted previous artifacts.

Integration prerequisites: foundation, jobs_discovery.

## fit — #1433

Own Fit person/evidence qualification, source-bound support determinations, eligibility, scoring/corrections and exact approved-variant-to-requirement coverage relations. Keep factual support separate from expression coverage, reusing current qualified requirement/profile revisions across jobs. Expose immutable snapshots for Resumes; Profile owns words and approval. New supported requirements request one grounded proposed variant via public authoring action; deduplicate rejected/deferred proposals. Missing approved wording cannot reduce person fit.

Acceptance: E2E demonstrates reused assessment, wording gaps without score loss, supported versus unsupported new requirements, approval only by user, correction/invalidation and stale source/wording version fences.

Integration prerequisites: foundation, profile, requirements.

## resumes — #1434

Own Resumes application/domain/adapters: deterministic full-baseline wording choice, exact chosen IDs, document coverage manifest, standalone editing, acceptance, rendering/PDF and retained locale capability. Select exactly one approved variant per achievement, retain all roles/achievements, maximize weighted distinct requirement coverage then complementary depth with stable tie breaks and no implicit brevity penalty. Report explicit layout conflicts. One simple advisory assembled-coherence LLM review; no re-scoring or recursive repair/polish loops. Exact approval/source checks mandatory. Reuse open PR #1426 baseline-copy/off mode with zero resume model calls.

Acceptance: End-to-end approved library -> person fit -> deterministic resume -> simple review -> real editable/rendered/exported PDF. Repeated unchanged input stable; every baseline achievement retained; no unapproved wording; model/render failure preserves last accepted artifact; user override records true review status; baseline copy calls no resume model.

Integration prerequisites: foundation, profile, requirements, fit.

## contacts_outreach — #1435

Own separate Contacts and Outreach feature packages, consolidating existing TypeScript and Python business writers. Preserve contact provenance/import/research/corrections and existing reviewed proposals, threads, sending receipts and follow-up controls. Contacts functions without Outreach. Use immutable public profile/job/contact data and preserve explicit message authorization, stale-save protection and ambiguous-send handling. Parked future warm-intake/follow-through expansion is excluded.

Acceptance: Real contact edit/import and message review lifecycle with controlled external provider, conflicting saves, stale approval, invalid response and retry without duplicate external send. No actual communications during QA.

Integration prerequisites: foundation, profile, jobs_discovery.

## applications — #1436

Own Applications: retained screening-answer library/review, application payloads, exact-payload permissions, assisted execution, outcomes and email feedback. Resume editing/acceptance belongs to Resumes. Consolidate canonical writes and use public immutable inputs. Preserve at-most-once intent/receipt semantics, final revalidation, stop/restart and honest unknown outcomes. This migrates current behavior only; #1128/#1032/#1029/#1195/#1040/#1034/#1018 expansion stays parked. No Cover Letter fields or attachments.

Acceptance: Real application preparation/review through synthetic external ATS/email boundary, invalidated approval after input changes, cancellation and worker restart, ambiguous submission and manual outcome without duplicate send. Never submit a real application.

Integration prerequisites: foundation, profile, jobs_discovery, resumes.

## career — #1437

Own separate Interviews, Learning and Digest packages and consolidate any duplicate TS/Python writers. Preserve current interview question/prep/session/note features, aspirations/plans/milestones and digest creation/acknowledgement. Use public owner snapshots; completing an activity never promotes a skill or changes fit. Optional company/application inputs remain optional. Do not implement parked interview expansion.

Acceptance: Real retained journeys create prep/session notes, track a learning plan without changing confirmed evidence/fit, and build/ack a digest without mutating source records. Exercise failure/retry and feature-removal boundaries.

Integration prerequisites: foundation, profile, jobs_discovery, fit.

## compensation — #1438

Own Compensation and Offers as separate feature packages. Preserve posted/market pay evidence, normalization/benchmarks and offer terms/scenarios/corrections/decisions. Keep Compensation core independent of JobCtrl IDs/models/config/DB/HTTP/Temporal; caller-supplied facts/source refs and injected real provider/model/rate ports. JobCtrl adapter owns mapping/persistence/scheduling. No new repository/package release now. Preserve unknown terms and correction history; do not invent pay facts.

Acceptance: Real controlled-provider compensation and offer journeys preserve evidence/dates/currency/components/unknowns, reject stale updates and run Compensation core without JobCtrl runtime dependencies.

Integration prerequisites: foundation, jobs_discovery, profile.

## web_shell — #1439

Own frontend shell/navigation/shared transport/query infrastructure, explicit feature composition and updated architectural lint/docs/AGENTS contract. Move business read ownership out of the giant Operations kernel. Shell owns one event connection; feature owners expose public panels/queries/mutations/invalidation. Retain accessibility, browser ports, correct optimistic rollback and bulk/parallel fetching. Coordinate shared DTO generation/route contracts with Python foundation. Do not rewrite other workers' feature UI; give them exact public interfaces early.

Acceptance: Build/type/lint and actual navigation across retained capabilities; one event connection, correct invalidation after real changes, feature removal removes registration without breaking core. No component/unit/snapshot tests added.

Integration prerequisites: foundation.

## web_core — #1440

Own Profile/Jobs/Fit/Requirements/Resumes frontend panels/views and feature-owned data access. Deliver the approved wording library, clear person-fit versus document-coverage distinction, new requirement proposal approval/reject/defer, full-baseline composition/editor/review/export and baseline-copy/off mode. Reuse sound existing editor components; remove Cover Letter UI. Cross-feature pages compose public interfaces. Coordinate shared shell and optional-feature UI owners; no competing edits to shared infrastructure.

Acceptance: Browser E2E drives real Python actions through profile wording approval, job analysis, reuse, deterministic resume, edits, review override and PDF; stale saves and provider failure are visible without losing accepted work.

Integration prerequisites: foundation, profile, requirements, fit, resumes, web_shell.

## web_optional — #1441

Own optional-feature frontend panels/data access for Discovery, Companies, Contacts, Outreach, Applications, Interviews, Learning, Digest, Compensation and Offers. Retain current functionality against new Python public contracts, with feature-owned queries/mutations and targeted invalidation. Dashboard/Activity/Settings compose these public panels. No parked capability expansion; no Cover Letter flows; remove cross-feature private store/API coupling.

Acceptance: Real browser journeys reach every retained feature, mutations persist correctly and relevant views refresh. Removing an optional feature leaves core Profile/Jobs/Fit/Resumes working. Coordinate shared shell and core UI ownership.

Integration prerequisites: foundation, web_shell, jobs_discovery, contacts_outreach, applications, career, compensation.

## runtime — #1442

Own source/installed launch, CLI runtime wiring, native launcher/runtime manifests, packaging/distribution, extension transport, demo transport and developer startup outside the web app and shared test harness. Replace Node Fastify/API and Python JSON-RPC launch paths completely, keeping one Python application authority. Preserve loopback security, credentials, provider readiness, static assets, SSE, health, startup/stop/restart and owned-process protection. Wire deliberate profile-only fresh-state cutover; no live-user reset in development. Inventory all real entry points, not just web/API.

Acceptance: Run source and built-package synthetic smoke through actual launch/API/CLI/worker/renderer and extension-compatible request path; stop/restart cleans owned processes and preserves unrelated controls. Installed profile-transfer check is one-off.

Integration prerequisites: foundation, resumes.

## e2e — #1443

Own all target E2E harness/config/scenarios, legacy unit/component/snapshot/isolated contract test retirement, CI test routing and test scripts. New small journey suite with real UI/Python API/domain/SQLite/files/Temporal/worker/renderer and controlled external API/model/provider boundary only. Reuse good startup helpers selectively, no internal dispatch/API stubs, semantic fake matcher, recorded model replay corpus, arbitrary sleeps or retries masking flakes. Coordinate package/script dependencies with foundation/runtime. Build once; bounded isolated worker stacks share dependencies. One-off profile-transfer verification stays outside recurring suite.

Acceptance: Measure total CI/focused journey time including setup on declared runner. Cover core happy paths plus stale input, conflicting saves, model/render failure, cancellation, real worker restart and uncertain submission. Report coverage mapping and actual timings; retain distinct real-provider change/pre-release proof.

Integration prerequisites: foundation, web_shell, runtime.

## cover_docs — #1444

Own Cover-Letter-only production files/assets/prompts and product/setup/user documentation removal. Inventory cross-feature Cover fields/config/workflow stages and send precise deletion requests to their owning workers; do not collide in shared files. Remove all product advertising, UI/API/CLI contracts and mandatory aggregate completion assumptions. No archival feature or historical runtime compatibility. Git history retains project history. Cover-only tests are removed by the E2E owner. Reconcile all owning docs to current accepted transformation and capability inventory.

Acceptance: Repository/runtime/UI/contract searches show no active Cover capability or product advertising; full-baseline resume and existing application paths work without letter fields or stage. Record any intentional historical changelog references separately.

Integration prerequisites: none.

