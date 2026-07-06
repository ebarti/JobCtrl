# Browser Extension — Capture, Assisted Autofill, and Deferred Guarded Submission

> **Status:** Proposed. Not started. Three explicitly gated phases; on merge of this plan only Phase 0 (substrate) and Phase 1 (capture) are greenlightable. Phases 2 and 3 are gated on prior phases and on owner go/no-go.
> **Audience:** implementing agents (high reasoning effort) and the repository owner (gate decisions).
> **Anchors verified against main @ `a488e4e9`.** Line numbers in this document are hints captured 2026-07-05 and WILL drift — locate every anchor by **symbol name** (grep/ripgrep). If a named symbol does not exist, STOP and report; do not create a lookalike.
> **Style:** additive and local-first. Net-new surface under `apps/extension/`; no existing code path is deleted or replaced. Browser submission is never the default and never automatic.
> **Companions:** `docs/plans/2026-07-03-oss-release-remediation-spec.md` (apply-safety hardening that Phase 3 is gated on); `docs/architecture/index.md`; `docs/architecture/domain-model/strategic.md`; `docs/user/security.md`; `docs/user/data-and-safety.md`; `docs/local-ts-api.md`; `docs/requirements.md`.
> **Goal:** Add a Manifest V3 browser extension as a new **capture/assist** surface for the local-first product, delivered in three explicitly gated phases — (1) save-a-job capture into the *existing* manual-capture/import path, (2) profile-backed *assisted autofill* on known ATS application forms with the user clicking submit, and (3, deferred) routing *guarded submission* through the *existing supervised apply path* — while preserving every existing safety and privacy invariant.

---

## 0. How to use this document

This is a plan, not a line-by-line script. Implementers are capable and should choose the smallest correct construction that satisfies the stated **objectives, contracts, invariants, acceptance template, and Definition of Done** for each phase. Where this plan says "reuse X", it means the existing symbol X is the substrate and must not be re-implemented or bypassed.

### 0.1 Phase gates and sequencing

Each phase ships as its own stacked PR (or PR series) and must be **merged to `main` with a QA `Gate: PASS`** before the next phase starts. Gates are stated as "what must have MERGED and passed", not "what is in flight".

| Phase | Name | Gate to START | Blocking collision with |
| --- | --- | --- | --- |
| P0 | Local API capability token + extension trust (server substrate) | Delivered by the OSS-spec §W2.3 origin-gate train (§3.3 is its requirements contract) | none (from `main`) |
| P1 | Capture (save-a-job from the browser) | P0 merged + QA PASS | discovery-controls / manual-capture surfaces |
| P2 | Assisted autofill (profile-backed suggestions; user submits) | P1 merged + QA PASS | apply/profile read-model surfaces |
| P3 | Guarded submission (route through supervised apply) — **DEFERRED** | P2 merged + QA PASS **and** §6.1 gate satisfied | apply workflow substrate |

```
P0 substrate ──► P1 capture ──► P2 assisted autofill ──► [ GATE §6.1 ] ──► P3 guarded submission
(from main)      (needs P0)      (needs P1)                                  (DEFERRED; do not
                                 2a deterministic                             implement in this plan)
                                 2b optional LLM drafts (2a merged)
```

P3 is **not** designed in implementation detail here (§6). Do not start it until its gate (§6.1) is satisfied and the owner gives an explicit go.

### 0.2 Non-negotiable ground rules

- Conventional Commits for every commit and PR title; PR body states What / Why / Validation.
- Never edit code on `main`; every phase is developed in its own worktree/branch; one reviewable unit per PR.
- **Additive:** this is a new surface. Do not remove or weaken any existing safety/privacy behavior (loopback bind, apply approval gate, dry-run guard, at-most-once, spend cap). Adding auth to the local API (P0) is a strict addition — unauthenticated loopback reads that exist today keep working unless the owner decides otherwise (§13, D-2).
- Public-history-safe: neutral product language only. Name ATS **integration targets** only where the repo already names them in code (`AtsKind` values: Workday, Greenhouse, Lever, Ashby). Never name or allude to rival products/companies; no marketing language.
- Do not commit or fixture any real profile data, resumes, cover letters, PDFs, browser profiles, SQLite databases, secrets, or logs. Fixtures use synthetic, fictional employers and the existing synthetic seed (`pnpm qa:seed`).
- Each phase that changes user-facing behavior, the local API, or safety notes MUST update the owning docs per the CLAUDE.md documentation matrix (enumerated per phase under "Docs").

### 0.3 Verification command matrix

Run the full column for the touched surface; a phase is not done until every required result holds.

| Surface | Commands | Required result |
| --- | --- | --- |
| Python worker | `uv --project workers/automation run --extra dev pytest -q` · `uv --project workers/automation run --extra dev ruff check .` | all pass |
| Domain-type parity | `uv --project workers/automation run python scripts/check-domain-type-parity.py` | no drift (if contracts/domain-types touched) |
| TS API | `pnpm api:check` · `pnpm api:test` | typecheck clean, tests pass |
| Web | `pnpm web:check` · `pnpm --filter @jobhunter/web test` · `pnpm --filter @jobhunter/web test-d` · `pnpm web:build` | all pass |
| Web e2e | `pnpm --filter @jobhunter/web e2e` | touched flows pass (baseline in `docs/backlog.md`) |
| Extension (new) | `pnpm --filter @jobhunter/extension check` · `…/extension test` · `…/extension build` · `…/extension e2e` | typecheck/lint clean, unit + privacy-invariant + e2e pass (§10) |
| Cross-stack | `pnpm check` · `pnpm test` | aggregate green |
| Privacy / hygiene | `python scripts/release_check.py` · `git diff --check` | privacy gate green (BR-055), no whitespace errors |

### 0.4 The acceptance template (every phase answers all seven)

For each phase this plan states, and each PR must preserve:

1. **Source of truth** — the canonical origin of every displayed/persisted claim.
2. **Owning bounded context** — which of the eight contexts owns the new state.
3. **Projection / read model** — the row(s) the UI reads (never a join).
4. **UI surface** — where the user sees and acts on it.
5. **Approving user action** — the explicit human action that authorizes the effect.
6. **Synthetic regression fixture** — the neutral, PII-free fixture that proves the invariant.
7. **Local QA path** — the manual product path a human/QA agent exercises.

### 0.5 Owner decision checkpoints (STOP and ask)

The items in §13 are **owner decisions**. Where a phase depends on one, the phase states its recommended default so implementation can proceed, but a change to the default requires owner sign-off. Do not silently pick a different answer.

---

## 1. Locked product invariants (do not re-litigate)

These hold across all phases and are testable (see §7, §10):

- **I-1 Localhost-only.** The extension's only network peer is the local API on loopback. Every request (fetch / EventSource / WebSocket) targets `127.0.0.1` / `localhost` / `[::1]`. The extension sends job or profile data to no other origin, ever.
- **I-2 No auto-submit.** The extension never submits a job application by itself in any phase. Phase 2 fills fields the **user** submits; Phase 3 (deferred) only hands off to the existing supervised apply path, which itself requires an explicit `approve_submit` decision.
- **I-3 Consented submission.** Any live application submission remains gated by the existing apply approval gate (`apply_approval_required`, default `True`) and its `approve_submit` decision. The extension cannot weaken or bypass this.
- **I-4 Every displayed claim is inspectable to its source.** Suggested field values and drafted answers show their source of truth (profile field, application default, or drafting prompt + evidence). No un-sourced value is ever presented as fill-ready.
- **I-5 No sensitive artifacts in fixtures.** Tests use synthetic fictional data only. Real resumes, PDFs, profiles, browser profiles, secrets, and databases never enter fixtures or history (enforced by `scripts/release_check.py`, BR-055).
- **I-6 Loopback bind preserved.** The API keeps its default loopback bind and its hard non-loopback guard (`apps/api/src/config.ts` » `resolveApiConfig`, the "Refusing to bind…" throw). The extension work never requires binding to a non-loopback host.

---

## 2. Ubiquitous language (new concepts introduced by this plan)

Uses the repo's Ubiquitous Language convention (`docs/architecture/domain-model/strategic.md`). New terms:

**Extension Capture** (Provenance / Value Object)
- Definition: a user-initiated save of a job from the browser — a canonical URL plus an optional description snapshot (rendered text and/or HTML) taken from the page the user is viewing.
- Source of truth: the page the user chose to save, recorded through the existing manual-capture import as a `PostingContentSnapshot` and a `Job`.
- Owning context: **Job Discovery**.
- Invariants: provenance records that this capture came from the extension (client + version) and carries `source_kind = user_mediated_capture` (`workers/automation/src/jobhunter/domain/discovery/source_registry.py` » `SourceKind.USER_MEDIATED_CAPTURE`; value object `ManualCaptureProvenance`). Never silently merges with another job — dedupe uses the canonical-identity path (§4.3).

**Captured Job** (Aggregate — existing `Job`)
- Definition: a `Job` created or matched from an Extension Capture. Not a new aggregate — it is the existing `Job` reached through the one legal creation path.
- Source of truth: `workers/automation/src/jobhunter/domain/discovery/use_cases.py` » `DiscoverJobsUseCase` (the only place `Job` aggregates are created).
- Owning context: **Job Discovery**.

**Answer Draft** (Read Model / Reviewable Artifact) — Phase 2
- Definition: a per-job, per-form set of **suggested** application-form values: deterministic field values sourced from the profile, plus (optionally, Phase 2b) drafted free-text answers to screening questions.
- Source of truth: `ProfileSnapshot` (`workers/automation/src/jobhunter/domain/profile/snapshot.py`) and `ApplicationDefaults` / `EeoVoluntary` (`workers/automation/src/jobhunter/domain/profile/value_objects.py`) for deterministic values; for free-text, a recorded drafting prompt + the profile evidence it was grounded in.
- Owning context: **Apply Automation** (mirrors the existing apply-review draft pattern; see `apps/web/src/contexts/apply/hooks/useApplyReviewMutations.ts`).
- Invariants: an Answer Draft is never auto-filled and never submitted; every value is inspectable to its source (I-4); free-text drafts never fabricate facts not present in the profile (reuse the tailoring truthfulness posture, `docs/architecture/tailoring.md`).

**Assisted Autofill Session** (view-local, ephemeral) — Phase 2
- Definition: the in-page interaction where the user reviews an Answer Draft against a detected ATS form, accepts values to fill, and then themselves clicks the ATS submit control.
- Owning context: the extension (client). No server aggregate; the durable record is the Answer Draft.
- Invariants: fills only fields the user accepts; the extension never dispatches the form's submit.

**Local Capability Token** (Auth credential) — Phase 0
- Definition: a locally generated secret the extension presents to the local API to prove it is a paired local client.
- Source of truth: generated and stored under `~/.jobhunter/` by the local stack (recommended: `jobhunter init` / API bootstrap), surfaced to the user for one-time pairing.
- Owning context: **Operations / runtime** (API), alongside existing runtime config (`apps/api/src/config.ts`).
- Invariants: inbound-only (authenticates *to* the local API); never written to SQLite, logs, traces, or artifacts (mirrors the credentials rule TR-013); loopback Host gate still applies on top of it.

---

## 3. Extension architecture (Manifest V3)

### 3.1 Package and build

- New workspace package `apps/extension/` (the `pnpm-workspace.yaml` glob already includes `apps/*`; `apps/` currently holds only `api` and `web`, so this is net-new). Name it `@jobhunter/extension`.
- Manifest V3, TypeScript, bundled with the repo's existing web toolchain (Vite). Components: a **background service worker** (the only code that talks to the local API), **content scripts** (Phase 2, on allowlisted ATS domains, DOM-only), a small **popup/side-panel** UI, and the static `manifest.json`.
- Reuse shared types from `packages/contracts` and `packages/domain-types` so the extension's API calls are typed against the same schemas the API validates (`ManualCaptureImportSchema`, etc.). Reuse the transport shape of `packages/api-client` where practical; do not fork request/response types.
- Dependency policy: honor the workspace `minimumReleaseAge` supply-chain guard in `pnpm-workspace.yaml`; no remotely hosted/eval'd code (MV3 forbids remote code and the security review enforces it, §8).

### 3.2 The local API is the only network peer (privacy boundary — testable)

- `manifest.json` declares **`host_permissions`** and a content-security-policy whose network reach (`connect-src`) is limited to the loopback API origins only: `http://127.0.0.1:<port>/*` and `http://localhost:<port>/*` (default port 8766; see §3.3 for port discovery). No `https://*/*`, no `<all_urls>` for network.
- Phase 2 content scripts additionally require **page/DOM** access on allowlisted ATS domains (to read and fill form fields). That is DOM access, not network egress. All network calls still go through the background worker to loopback only. The distinction is the crux of I-1 and is asserted by the privacy-invariant test (§7, §10).
- The extension performs no analytics, no crash reporting, no auto-update pings to third parties beyond what the browser store platform itself does (a store-distribution consequence captured as an owner decision, §9).

### 3.3 Authenticating to the local API (P0 substrate)

Today the local API has **no authentication**. Its only gates are network-locality checks (`apps/api/src/server.ts` `onRequest` hook → `forbidden_host` for non-loopback `Host`; `cross_site_request` for mutations whose `Origin`/`Referer` is not loopback, via `apps/api/src/local-origin.ts` » `isTrustedMutationSource`), and CORS restricted to loopback origins (`apps/api/src/local-origin.ts` » `LOCAL_ORIGIN_PATTERNS`, registered at `apps/api/src/server.ts` `app.register(cors, …)`). A `chrome-extension://<id>` origin does **not** match those patterns, so an extension mutation would be rejected `cross_site_request` and would receive no `Access-Control-Allow-Origin`. This is the central constraint the extension must resolve, and it is why P0 exists.

P0 objective: give the extension a first-class, least-privilege way to authenticate to the local API without weakening loopback-only posture.

**Ownership note (2026-07-05).** P0 is not implemented by the extension
workstream. It is delivered by the OSS release remediation spec's §W2.3
origin-gate train (`docs/plans/2026-07-03-oss-release-remediation-spec.md`),
which already owns this exact server surface (`apps/api/src/server.ts`,
`apps/api/src/local-origin.ts`). This section — the token model, server
trust rules, contracts, and scope below, plus owner decisions D-1/D-2 (§13)
— is the requirements contract that train must satisfy. The extension
workstream starts at P1 and consumes the substrate; it must not re-implement
API authentication.

- **Token.** The local stack generates a Local Capability Token (§2), stored under `~/.jobhunter/` with restrictive permissions, surfaced to the user in the web app Settings surface for one-time pairing (recommended). The extension stores it in extension storage and presents it on every request (recommended header: `Authorization: Bearer <token>`).
- **Server trust.** The API validates the token on the extension-facing routes and, for token-authenticated requests, treats the request as a trusted local client: it must still pass the loopback `Host` gate, and CORS must echo the extension origin for those routes. The exact relaxation of the mutation-origin check for token-bearing requests is **owner decision D-1** (§13); recommended default: a valid token satisfies the trusted-mutation-source requirement while the loopback `Host` gate remains mandatory.
- **Contracts.** Token issuance/rotation and the extension pairing exchange are added to `packages/contracts` so both sides share one schema. No token value is ever logged (TR-013, TR-014).
- **Scope.** The token authorizes only the extension-facing capability set (capture in P1; capture + read-only profile/answer-draft in P2). It does not grant apply-submission authority — that stays behind the apply approval gate (I-3).

### 3.4 Behavior when the local stack is down

- The extension probes readiness with `GET /v1/health` (`apps/api/src/server.ts` » `/v1/health`), the same signal the web app uses (`apps/web/src/contexts/operations/hooks/useHealthQuery.ts`; `ConnectionStatusPill`). Treat connection-refused / timeout / non-200 as "stack down", mirroring the client's timeout-and-error handling (`packages/api-client/src/client.ts`).
- When down: the popup shows a clear "local app not running" state with the command to start it (`pnpm dev`), and **capture is queued locally in extension storage** (URL + snapshot) so the user does not lose the page; nothing is sent until the stack returns. Queued captures never leave the machine (I-1) and expire/clear on a bounded policy (owner decision D-5, §13).
- Realtime: when live, the extension MAY subscribe to `GET /v1/events/stream` for capture/answer-draft updates (same SSE contract as the web app; `docs/local-ts-api.md`), but must degrade to on-demand `GET` polling if SSE is unavailable.

### 3.5 Bounded-context ownership map

- **Captured jobs → Job Discovery.** Extension captures flow through the existing manual-capture import into `DiscoverJobsUseCase`; the extension adds no new job aggregate.
- **Answer drafts → Apply Automation**, sourced from **Candidate Profile** (`ProfileSnapshot`).
- **The capability token / runtime trust → Operations / API runtime.**
- The extension is a *client* of these contexts via the local API; it does not own domain state beyond ephemeral session/queue state in extension storage.

---

## 4. Phase 1 — Capture (gate: this plan + P0 merged)

**Objective.** From any job page in the browser, the user saves the job (URL + optional description snapshot) into JobHunter through the **existing** manual-capture/import path, so the captured job is deduped, provenance-stamped, snapshotted, and visible in the product exactly like any other manually captured job.

**Branch:** `feat/extension-capture` · **PR title:** `feat(extension): save-a-job capture into manual-capture path`

### 4.1 Contract

- The capture request reuses the existing `ManualCaptureImportSchema` shape (`packages/contracts/src/schemas.ts`): `captureMode` ∈ `MANUAL_CAPTURE_MODE_VALUES` (`current_page`, `saved_html`, `copied_url`, `pasted_text`, `email_import`), `capturedUrl` (≤2048), `contentText` (≤200k) and/or `contentHtmlBase64` (≤8MB), `note` (≤400), `futureManualActionRequired`. The extension uses `current_page` (rendered text) or `saved_html` (HTML snapshot). At least one of URL/text/HTML is required (existing `.refine`).
- **Substrate gap to close.** The current import endpoint (`POST /v1/discovery/manual-capture/:itemId/import`, `apps/api/src/server.ts`) and its worker (`import_manual_capture_item`, `workers/automation/src/jobhunter/infrastructure/discovery/production_wiring.py`) require a **pre-existing pending `manual_capture_queue` row** — they *update* a row that discovery's manual-action path seeded. An extension capture has no such row. Phase 1 therefore adds a **capture-ingest** entry point that (a) creates the pending `manual_capture_queue` row for an extension-originated capture (new manual-action reason, recommended `browser_extension_capture`, added to `MANUAL_ACTION_REASON_VALUES`), then (b) drives the existing import logic unchanged. Do **not** fork the import logic; reuse `DiscoverJobsUseCase` + `CapturePostingSnapshotUseCase` exactly as `import_manual_capture_item` does today.
- The response reuses `ManualCaptureImportResponse` (carries `provenance.sourceKind = "user_mediated_capture"`, `originatingUrl`, `captureMode`). The extension surfaces the returned `jobKey` and whether the job was newly created, matched an existing job, or quarantined.

### 4.2 Substrate reused (do not re-implement)

- Import + snapshot + enrichment promotion: `import_manual_capture_item` → `_manual_capture_posting` (`source=Source(board="User-mediated capture")`, `strategy=SearchStrategy.MANUAL`, `ats_kind=AtsKind.OTHER`, `source_native_id=<item id>`) → `DiscoverJobsUseCase.execute(...)` → `CapturePostingSnapshotUseCase.execute(..., policy_id="user_mediated_capture", promote_to_job_enrichment=True)`.
- API/worker bridge: `apps/api/src/manual-capture-worker.ts` » `createWorkerManualCaptureImporter` (spawns `python -m jobhunter.discovery.manual_capture_import`), `listManualCaptureQueue` / `dismissManualCapture` (`apps/api/src/discovery-controls.ts`).
- Web client + hooks: `packages/api-client/src/client.ts` » `manualCaptureQueue` / `importManualCapture` / `dismissManualCapture`; `apps/web/src/contexts/discovery/hooks/useDiscoveryProductControlMutations.ts` » `useManualCaptureImportMutation` / `useManualCaptureDismissMutation`; query hook `apps/web/src/contexts/operations/hooks/useDiscoveryProductControlsQuery.ts` » `useManualCaptureQueueQuery`; key `discoveryKeys.manualCapture`.

### 4.3 Dedupe and provenance

- **Dedupe.** Reuse the canonical-identity path: `normalize_observed_url` (`workers/automation/src/jobhunter/domain/discovery/identity.py` — strips fragment, trailing slash, and tracking params incl. `utm_*`, `gh_*`, `ashby_jid`, `lever-source`, `src`, `ref`) and `SqliteJobRepository.find_canonical_owner` (resolution order: source observation by `(source_id, source_native_id)` → exact `jobs.url` → `job_canonical_identities.canonical_url` → normalized-observed-url match). A capture of a URL already known to JobHunter attaches to the existing `Job`; it never creates a silent duplicate (BR-021). Uncertain matches go to quarantine (`discovery_quarantine_entries`), never a fuzzy merge.
- **Provenance (captured-by-extension as a source).** Preserve `source_kind = user_mediated_capture` and extend `ManualCaptureProvenance` to record the capture client (recommended fields: `capture_client = "browser_extension"`, extension version) so the source registry can attribute capture volume/quality to the extension. Recommended `source_id` namespace: `manual_capture:extension` (distinct from the per-item fallback `manual_capture:<itemId>`), registered as a `USER_MEDIATED_CAPTURE`-kind source in the source registry (`source_registry_entries`) so it appears in Discovery source controls with quality stats (BR-018, BR-020). Exact provenance field names/source-id scheme is owner decision **D-3** (§13).

### 4.4 Projection / read model and UI surface

- **Projection / read model:** the `manual_capture_queue` row (flipped to `status='imported'`, `job_key=<captured url>`), the jobs read model (`jobs` → jobs list projection), `discovery_quarantine_entries` when quarantined, and the source registry entry for the extension source.
- **UI surface:** the extension popup confirms capture and links to the job. In the web app, captured jobs appear in the **Jobs** view (`apps/web/src/views/jobs/JobsView.tsx` / `JobsTable.tsx`) and the **Manual capture** tab of Discovery controls (`apps/web/src/contexts/discovery/components/DiscoveryProductControls.tsx` » `ManualCapturePanel`; view `apps/web/src/views/discovery/DiscoveryView.tsx`). Realtime refresh rides the existing SSE invalidation router; if a new manual-action reason or event type is added, its handler must be registered so the `every-event-has-handler.test.ts` parity test stays green.

### 4.5 Acceptance template (Phase 1)

1. **Source of truth:** the saved page (URL + snapshot) recorded as a `Job` + `PostingContentSnapshot` with `user_mediated_capture` provenance.
2. **Owning bounded context:** Job Discovery.
3. **Projection / read model:** `manual_capture_queue` (imported), jobs list projection, `discovery_quarantine_entries`, source registry entry.
4. **UI surface:** extension popup; web Jobs view + Discovery "Manual capture" tab.
5. **Approving user action:** the user clicking "Save job" in the extension is the explicit capture consent; ambiguous captures require a quarantine decision in Discovery.
6. **Synthetic regression fixture:** a PII-free fixture posting for a fictional employer (URL + HTML) that exercises (a) new-job creation with correct provenance, (b) dedupe/attach against an already-known URL (including a tracking-param variant), and (c) quarantine on an ambiguous capture. Python fixture around the capture-ingest → import path; a TS API test around the capture endpoint.
7. **Local QA path:** start `pnpm dev`; load the unpacked extension; pair it (P0 token); capture a synthetic posting; confirm it appears in Jobs and the Manual capture tab with extension provenance; re-capture the same URL (with tracking params) and confirm attach-not-duplicate; stop the stack and confirm capture queues locally and syncs on restart.

### 4.6 Definition of Done (Phase 1)

- [ ] Extension popup captures the current page (URL + snapshot) and sends it to the local API over loopback with the P0 token.
- [ ] Capture-ingest creates the pending queue row and drives the **existing** import logic; no import logic is forked.
- [ ] Dedupe attaches to the existing `Job` for a known URL (incl. tracking-param variants); ambiguous captures quarantine; no silent duplicates (BR-021).
- [ ] Provenance records `user_mediated_capture` + extension client; the extension source is visible in Discovery source controls.
- [ ] Captured jobs appear in the Jobs view and Manual capture tab; SSE parity test green.
- [ ] Stack-down capture queues locally and never leaves the machine; syncs on restart.
- [ ] Docs updated: `README.md` (extension capture + how to install/pair), `docs/user/data-and-safety.md` and `docs/user/security.md` (extension boundary), `docs/local-ts-api.md` (any new/changed route), `docs/local-reliability-qa.md` (QA path), `docs/requirements.md` (satisfy BR-019), `package.json` (new workspace scripts).
- [ ] Full sweep (§0.3) passes.

---

## 5. Phase 2 — Assisted autofill (gate: Phase 1 merged + QA PASS)

**Objective.** On a known ATS application form, the extension shows profile-backed suggestions the user reviews and accepts; the **user** clicks the ATS submit control. Nothing auto-fills without review and nothing auto-submits, ever (I-2).

Ships in two sub-gated steps to bound risk:

- **P2a — deterministic suggestions only** (no LLM). Branch `feat/extension-autofill-deterministic`.
- **P2b — optional LLM-assisted free-text answer drafts** (gated on P2a merged + QA PASS). Branch `feat/extension-answer-drafts`.

### 5.1 ATS families to start with

Start with the families the repo already has first-class knowledge for — the `AtsKind` enum and detector already recognize them:

- Detection: reuse `workers/automation/src/jobhunter/infrastructure/discovery/production_wiring.py` » `_detect_ats_kind` (host-based: Workday `myworkdayjobs.com`, Greenhouse `greenhouse.io`, Lever `lever.co`, Ashby `ashbyhq.com`) and `AtsKind` (`workers/automation/src/jobhunter/domain/discovery/identity.py`). TS parity: `apps/api/src/discovery-controls.ts` » `isSharedAtsHost` / `sourceKindFromId`.
- Content-script form mapping is per-ATS and net-new (there are **no** existing apply-side form/selector adapters — apply today is a generic LLM+Playwright agent, `workers/automation/src/jobhunter/apply/prompt.py`, which Phase 2 does **not** use). Begin with the two most structured families and expand; exact starting set and rollout order is owner decision **D-4** (§13). The content-script host allowlist is exactly these ATS domains (least privilege).

### 5.2 Source of truth for suggestions

- Deterministic fields (P2a): `ProfileSnapshot` (`workers/automation/src/jobhunter/domain/profile/snapshot.py`) — identity/contact/address/links (`PersonalInfo`), work authorization/sponsorship (`WorkAuthorization`), compensation (`Compensation`), availability (`Availability`), and screening defaults (`ApplicationDefaults`, `EeoVoluntary` — whose docstring already frames them as "default form-field values consumed by Apply Automation when the agent encounters generic screening prompts"). No new profile fields are invented; if a form needs a field the profile lacks, the suggestion is absent and labeled "not in your profile" (I-4).
- Free-text answers (P2b): an **Answer Draft** grounded strictly in profile evidence, with the drafting prompt and the evidence recorded and inspectable (I-4). Reuse the truthfulness/fabrication posture from `docs/architecture/tailoring.md`; a drafted answer that cannot be grounded is shown as empty with a "needs your input" prompt, never fabricated. LLM drafting reuses the existing spend-cap discipline (§6.2) so P2b cannot run over budget.

### 5.3 The no-auto-submit invariant (P2 core)

- The content script fills only fields the user has accepted, and **never** dispatches the form's submit. This is asserted by a regression test that drives a synthetic ATS form and verifies the submit handler is never invoked by extension code (§10). This mirrors, at the client layer, the server-side dry-run guard (`workers/automation/src/jobhunter/apply/chrome.py` » `install_dry_run_cdp_guard` / `_FORM_SUBMIT_GUARD_SOURCE`) — but Phase 2 runs in the user's own browser, so the guarantee is structural (the extension has no submit code path) plus tested.

### 5.4 Owning context, projection, UI

- **Owning context:** Apply Automation owns Answer Drafts (sourced from Candidate Profile). Deterministic P2a suggestions are computed read-only from `ProfileSnapshot` and need no new persistent aggregate; the Answer Draft (P2b, and the record of what was suggested/accepted) is persisted as an apply-side read model, mirroring the resume-review-draft pattern (`apps/web/src/contexts/apply/hooks/useApplyReviewMutations.ts`, e.g. `useCreateResumeReviewDraftMutation`).
- **Projection / read model:** a new answer-draft projection (per job + detected form), consistent with the apply projection conventions (`apply_run_projections` shape, `workers/automation/src/jobhunter/infrastructure/projections/sqlite_projection_store.py`) — rebuilt from events, read directly by the API. New domain event types get a registered SSE handler (parity test).
- **UI surface:** an in-page review overlay / extension side-panel listing each suggested field and its source; the web app **Apply Review** surface (`apps/web/src/views/apply-review/ApplyReviewView.tsx`) shows the Answer Draft with per-value source attribution so drafts are auditable outside the extension too.

### 5.5 Acceptance template (Phase 2)

1. **Source of truth:** `ProfileSnapshot` / `ApplicationDefaults` / `EeoVoluntary` for deterministic fields; recorded prompt + profile evidence for free-text Answer Drafts.
2. **Owning bounded context:** Apply Automation (Answer Drafts), sourced from Candidate Profile.
3. **Projection / read model:** answer-draft projection (per job + form), read by the API; the web Apply Review read model surfaces it.
4. **UI surface:** extension in-page review overlay / side-panel; web Apply Review view.
5. **Approving user action:** the user reviews and accepts each suggested value/answer, then clicks the ATS submit control themselves. The extension performs no submission.
6. **Synthetic regression fixture:** PII-free static fixtures of each supported ATS form (fictional employer), plus a synthetic profile from `pnpm qa:seed`; assert (a) deterministic values map to the correct fields, (b) missing profile data yields a labeled-absent suggestion (no fabrication), (c) the submit handler is never invoked by extension code, and (d) an Answer Draft's free-text is grounded in the provided evidence (P2b).
7. **Local QA path:** start `pnpm dev`, seed a synthetic profile, open a synthetic ATS form fixture, load the extension, confirm suggestions populate on accept with visible sources, confirm nothing submits, and confirm the Answer Draft appears in web Apply Review with source attribution.

### 5.6 Definition of Done (Phase 2)

- [ ] Extension detects a supported ATS form and shows profile-backed suggestions with a visible source per field (I-4).
- [ ] Deterministic suggestions come only from `ProfileSnapshot`/defaults; absent data is labeled, never fabricated.
- [ ] (P2b) Free-text Answer Drafts are grounded in profile evidence, inspectable to prompt+evidence, non-fabricating, and spend-capped.
- [ ] The extension fills only accepted fields and never submits; the "never submits" test passes.
- [ ] Answer Drafts persist and surface in web Apply Review with per-value source attribution; SSE parity test green.
- [ ] Content-script host permissions are limited to the supported ATS domains (least privilege); privacy-invariant test green (§7).
- [ ] Docs updated: `docs/user/security.md` + `docs/user/data-and-safety.md` (autofill boundary, no-submit), `docs/architecture/` (Answer Draft ownership + projection), `docs/local-ts-api.md` (routes), `docs/local-reliability-qa.md` (QA), `docs/requirements.md` (BR-005 assist surface, without implying submission).
- [ ] Full sweep (§0.3) passes.

---

## 6. Phase 3 — Deferred guarded submission (gate defined; no implementation detail)

Phase 3 would let a reviewed application be **submitted** by routing it through the **existing supervised apply path** — never a new submission path in the extension. This plan deliberately does **not** design Phase 3's implementation. It defines the gate and names the required substrate so a future plan can build on it safely.

### 6.1 The gate to even START Phase 3

All of the following must hold:

- [ ] Phase 1 and Phase 2 are merged to `main` with QA `Gate: PASS`.
- [ ] Apply-safety hardening from the active OSS release remediation spec (`docs/plans/2026-07-03-oss-release-remediation-spec.md`, apply-safety workstream) is complete and merged.
- [ ] The extension security review (§8) has been completed and published, and the privacy-invariant test (§7) is enforced in CI.
- [ ] The release privacy gate is green (`scripts/release_check.py`, BR-055) for the extension package and any distributed archive.
- [ ] Explicit owner go/no-go (owner decision **D-6**, §13).

### 6.2 Required substrate (must be reused, never bypassed)

A Phase-3 submission MUST enter through the existing apply workflow entry (`apply` JSON-RPC method → `ApplyWorkflow`), inheriting all four mechanisms — not the raw launcher, not the extension:

- **Approval gate:** `apply_approval_required` (default `True`, `workers/automation/src/jobhunter/infrastructure/scoring/criteria_provider.py` » `read_apply_approval_required`) enforced in the worker's claim transaction (`workers/automation/src/jobhunter/apply/launcher.py` » `_latest_apply_review_decision`, the `approval_required and not dry_run` branch); consent recorded via `POST /v1/jobs/:jobKey/apply-review/decision` (`apps/api/src/server.ts`; `apps/api/src/application-feedback.ts` » `recordApplyReviewDecision`, decision `approve_submit` from `APPLY_REVIEW_DECISION_VALUES`).
- **Dry-run guard:** the `dry_run` flag + aggregate invariant (`workers/automation/src/jobhunter/domain/apply/aggregate.py`) + CDP network guard (`apply/chrome.py` » `install_dry_run_cdp_guard`).
- **At-most-once lifecycle:** deterministic `apply_workflow_id` = `apply-{tenant}-{job_key}` (`workers/automation/src/jobhunter/workflow_specs.py`), Temporal `USE_EXISTING` conflict policy, single live attempt (`apply/workflow.py` » `_APPLY_LIVE_RETRY`), active-run exclusion (`_has_active_apply` / `list_active`), and the `ApplySubmitIntended` checkpoint (`workers/automation/src/jobhunter/domain/apply/process_manager.py`).
- **Spend ceiling:** the `check_spend_budget` preflight (`workers/automation/src/jobhunter/llm.py`) raising `BudgetExceededError`; daily budget default $25 (`read_daily_budget_usd`).
- **Read model / UI:** `apply_run_projections`; Apply Review queue + `ApplyReviewDecisionControls`; apply events (`ApplyRunStarted`, `ApplySubmitIntended`, `ApplicationSubmitted`, `ApplicationFailed`, `ApplyReviewDecisionRecorded`).

### 6.3 What Phase 3 must NOT do

- Must not add a submission code path to the extension or content scripts.
- Must not weaken, flag-off, or bypass the approval gate, dry-run guard, at-most-once lifecycle, or spend cap.
- Must not submit as a side effect of capture or autofill.
- The extension's role is limited to handing a reviewed application to the supervised path and reflecting its status; the human `approve_submit` decision remains mandatory (I-2, I-3, BR-001, BR-023, BR-054).

---

## 7. Privacy boundary (testable invariant)

I-1 is enforced and tested, not asserted:

- **Manifest test:** a unit test parses the built `manifest.json` and fails if `connect-src` (or `host_permissions` used for network) contains any non-loopback origin, or if `<all_urls>`/`https://*/*` network reach is present. Content-script **page** permissions on ATS domains are allowed and checked against an explicit allowlist (Phase 2 only).
- **Bundle scan:** a test scans the built extension bundle for network calls (`fetch`, `XMLHttpRequest`, `EventSource`, `WebSocket`) whose target is not a loopback origin, failing on any non-loopback literal or dynamic base that is not the configured local API.
- **Data-egress assertion:** an e2e check confirms that during capture and autofill the only outbound requests observed are to the loopback API.
- **Release gate:** `scripts/release_check.py` covers the extension package and any packaged archive for profile needles, secrets, and forbidden artifacts (BR-055); telemetry stays off/absent (TR-014, TR-015).

---

## 8. Security review (required before any release)

The extension is a high-privilege surface (content scripts on ATS pages, a local capability token, DOM read/fill). A dedicated security review MUST pass before any distribution (developer or store), and again before Phase 3:

- **Least privilege:** minimum MV3 permissions; network limited to loopback (§7); Phase 2 host permissions limited to the supported ATS domains; no broad `<all_urls>`.
- **No remote code:** everything ships in the package; MV3 remote-code ban verified; supply chain respects `minimumReleaseAge`; dependency review.
- **Token handling:** token stored in extension storage only, never logged or transmitted off-box, rotatable, scoped (§3.3, TR-013).
- **Prompt-injection resistance (P2b):** ATS page text is untrusted input to any drafting prompt; apply the repo's defensive posture (the apply path already treats page content as adversarial). Drafted answers are grounded and non-fabricating (I-4) and never trigger submission.
- **No PII exfiltration:** privacy-invariant tests (§7) enforced in CI; profile/job data never leaves loopback.
- **Content-script isolation:** no injection of secrets/token into page context; DOM interaction only.
- **Review artifact:** run the repository security-review discipline (`/security-review`) on each phase's diff; record the outcome in the PR. Update `docs/user/security.md` with the extension's place in the trust model.

---

## 9. Distribution and signing (owner decision)

**Owner decision D-7 (§13).** For a local-first, single-user tool, the default recommendation is to ship the extension as a **signed, self-distributed package plus developer/unpacked install** documented in `README.md`, and to **defer any public browser-store listing** until after the security review and at least Phase 1–2 are shipped. A store listing implies a publisher account, store review, a public privacy policy, auto-update via the store, and store-platform telemetry — all of which the owner must accept explicitly. Whichever path is chosen, signing keys are the owner's and are never committed; store submission (if any) is owner-executed.

---

## 10. Verification and extension-specific test strategy

Beyond §0.3:

- **Package tooling:** `@jobhunter/extension` gets `check` (tsc), `test` (Vitest unit: capture payload building, ATS detection reuse, field mapping, source labeling, offline queue), `build`, and `e2e`.
- **Privacy-invariant tests** (§7): manifest test + bundle scan + egress assertion — these are non-negotiable gates.
- **No-submit test** (Phase 2): drive a synthetic ATS form fixture; assert the extension never invokes submit.
- **Contract tests:** the extension's requests validate against the same `packages/contracts` schemas the API enforces (e.g. `ManualCaptureImportSchema`); add a type-level test if new contracts are introduced, and run `scripts/check-domain-type-parity.py` when domain types change.
- **E2E with the extension loaded:** Playwright launches Chromium with the built extension (persistent context + `--load-extension`), against a `pnpm dev` stack seeded via `pnpm qa:seed`, exercising: pair → capture → job appears (P1); detect form → review → accept → (assert no submit) → draft in Apply Review (P2). Keep any known-failing baseline recorded in `docs/backlog.md`.
- **SSE parity:** any new domain event type must have a registered handler so `apps/web/src/contexts/operations/every-event-has-handler.test.ts` passes.

---

## 11. Non-goals

- Do **not** implement Phase 3 (guarded submission) in this plan; only its gate and substrate are defined (§6).
- Do **not** build per-ATS *submission* automation in the extension; submission stays in the supervised apply path.
- Do **not** add profile fields or a general screening-answer knowledge base beyond grounded Answer Drafts; the profile aggregate remains the source of truth.
- Do **not** support non-loopback / hosted operation, remote sync, or any third-party network peer (TR-002, I-1).
- Do **not** weaken the local API's loopback bind, existing gates, or apply-safety mechanisms.
- Do **not** support browsers/engines beyond the initial MV3 target chosen by the owner (D-8, §13); no cross-browser matrix in v1.
- Do **not** name or market against rival products.

## 12. Risks

1. **Extension origin vs. mutation gate.** The current CORS/mutation-origin gates reject `chrome-extension://`. *Mitigation:* P0 introduces token auth + explicit extension-origin trust before any extension write (D-1); loopback `Host` gate stays mandatory.
2. **Adding auth to a previously unauthenticated API.** New token path could regress local reads or the web app. *Mitigation:* strictly additive (existing loopback reads unchanged unless the owner opts in, D-2); full API test sweep; token scoped to extension routes.
3. **Capture path assumes a pre-seeded queue row.** Reusing import naively would fail for extension captures. *Mitigation:* P1 adds capture-ingest that seeds the row then reuses import logic unchanged (§4.1); covered by fixture (b)/(c).
4. **Autofill fabrication / mis-mapping.** Wrong field mapping or invented answers would damage real applications. *Mitigation:* deterministic-first (P2a), absent data labeled not-fabricated, grounded non-fabricating drafts (P2b), per-value source visible (I-4), and the user reviews before submit.
5. **Privacy leak via content scripts.** Broad host/network permissions could exfiltrate data. *Mitigation:* least-privilege manifest; network limited to loopback; privacy-invariant tests as CI gates (§7); security review (§8).
6. **Prompt injection from ATS pages (P2b).** Page text is adversarial. *Mitigation:* treat page content as untrusted; grounded drafting; no submission authority; security review.
7. **Store distribution pulls in third-party telemetry / auto-update.** *Mitigation:* default to self-distribution + defer store listing to an explicit owner decision (§9, D-7).
8. **Scope creep toward auto-apply.** *Mitigation:* I-2 and §6.3 forbid extension submission; Phase 3 is gated and out of scope here.

## 13. Open owner decisions

- **D-1 (P0):** Exact token model — header name, storage location under `~/.jobhunter/`, pairing UX (Settings copy vs. localhost pairing page), and whether a valid token relaxes the mutation-origin gate (recommended: yes, with loopback `Host` still required).
- **D-2 (P0):** Do existing unauthenticated loopback API reads stay open, or does the owner want auth required for all non-web clients? (Recommended: keep additive; extension routes require token; web app unchanged.)
- **D-3 (P1):** Extension provenance fields and source-id scheme (recommended `source_id = manual_capture:extension`, provenance `capture_client="browser_extension"` + version) and whether to add a `browser_extension_capture` manual-action reason.
- **D-4 (P2):** Starting ATS family set and rollout order among Workday/Greenhouse/Lever/Ashby.
- **D-5 (P0/P1):** Offline capture queue retention policy (size/age limits, clear-on-pair-change).
- **D-6 (P3):** Go/no-go to begin Phase 3 once §6.1 is satisfied.
- **D-7 (§9):** Distribution channel (self-distributed signed package vs. public store) and signing key ownership.
- **D-8 (§3):** Target browser/engine for v1 (single MV3 target vs. more).
- **D-9 (P2b):** Whether to ship LLM-assisted free-text drafts at all, or keep Phase 2 deterministic-only for v1.

## 14. Requirements traceability

New/affected requirements this plan advances (`docs/requirements.md`) — implementers verify wording is satisfied, and add rows if a genuinely new requirement emerges:

- **Capture:** BR-019 (manual capture of user URLs / saved HTML / pasted text), BR-017/BR-018/BR-020/BR-021 (source preference, observability, provenance preservation, dedupe without silent merges), BR-043 (closed/unavailable postings inspectable).
- **Assist:** BR-005 (apply surface status/dry-run — as an assist surface, not submission), BR-029/BR-030/BR-048/BR-049 (profile data local, editing preserves behavior, no leakage of raw profile/job text), BR-006 (product views).
- **Submission safety (Phase 3, deferred):** BR-001 (no submit/bypass without explicit authorization), BR-023 (auto-apply never gated by score alone), BR-054 (at-most-once), BR-050 (spend ceiling).
- **Privacy / local-first / security:** TR-002 (hosted stays out of local mode), TR-005 (API local-only defaults, loopback, restrictive browser access), TR-006 (SQLite local source of truth), TR-009 (events → projections), TR-013 (credentials via secret port, never persisted to SQLite/logs/artifacts), TR-014/TR-015 (no raw private content in telemetry; telemetry disableable), TR-033 (JSON-RPC + health-gated worker actions), BR-055 (release privacy gate).

---

_When a phase lands, move its status to the `docs/plans/README.md` "Historical Spec Ledger" with delivery PRs, and update the owning canonical docs per the CLAUDE.md documentation matrix._

## Delivery Model: Stacked PRs On This Plan

Implement this plan as a series of stacked PRs that begin on this plan's
branch:

- The first implementation PR uses this plan PR's branch as its base; each
  subsequent PR stacks on the previous one. One reviewable concern per PR;
  Conventional Commit titles.
- As a parent merges, retarget the next PR to `main` before merging it
  (retarget-before-merge; never merge a PR whose base branch is already
  merged and deleted).
- If this plan PR has already merged to `main`, start the stack from `main`
  instead — the instruction is "stack on the plan", not "recreate it".
- Each PR states which plan phase it delivers and runs that phase's
  verification commands from this plan before requesting review.
- Do not begin implementation while this plan's stated gates or
  dependencies are unmet.
- The stack begins at Phase 1 (capture). The §3.3/P0 auth substrate is delivered by the OSS-spec §W2.3 train, not by this stack.
