# Frontend TanStack Migration Plan

## 1. Purpose & Scope

### Purpose

This plan describes the **canonical migration path** from JobHunter's current
frontend — a single 2,527-line `apps/web/src/App.tsx` with manual
`useState` / `useEffect` plumbing, a `useState<View>` view switcher, hand-rolled
`requestSeq` stale-response guards, untyped `window.dispatchEvent`
cross-component coordination, and zero tests — to the canonical target
defined in [`docs/frontend-target.md`](../../frontend-target.md).

The target is the architectural twin of the backend's DDD + Hexagonal
target ([`docs/ddd-target.md`](../../ddd-target.md)) which the worker
codebase realised in PR #21 (see
[`docs/plans/implemented/2026-05-06-ddd-migration.md`](../implemented/2026-05-06-ddd-migration.md)).
This plan applies the same architectural treatment to the frontend.

This plan delivers:

- **Three-layer state separation** (server / URL / client) per
  `frontend-target.md` §2.1 — TanStack Query for server state, TanStack
  Router (typed search params via Zod) for URL state, Zustand+context
  for client state.
- **Eight frontend bounded contexts** (Discovery, Enrichment, Profile,
  Scoring, Materials, Apply, Pipeline, Operations) under
  `apps/web/src/contexts/`, mirrored 1:1 with the backend per §3.
- **Three view composers** (Dashboard, Jobs, Artifacts) under
  `apps/web/src/views/` per §3.10.
- **File-based TanStack Router** with per-route Zod search-param
  schemas and per-route code-splitting per §4.3.
- **Per-context query-key factories** with `TenantId` as the first
  segment of every key per §4.1.
- **Hexagonal frontend ports** (`ApiClientPort`, `EventStreamPort`,
  `StoragePort`, `SessionPort`, `ClipboardPort`, `OpenInOsPort`,
  `TelemetryPort`, `FeatureFlagPort`) under `apps/web/src/shared/ports/`
  per §6.
- **shadcn/ui primitives** (Radix + Tailwind copy-paste) under
  `apps/web/src/shared/ui/` per §4.7, with `lucide-react` icons.
- **TanStack Table v8** for `JobsView` / `ArtifactsView` per §4.5.
- **TanStack Form** (Zod resolvers) for the Profile, Settings,
  Credentials, and Resume Import surfaces per §4.6.
- **A new SSE endpoint** `GET /v1/events/stream` on `apps/api/` per
  §7.1, plus a frontend `EventStreamProvider` and pure-function
  invalidation router per §7.3 / §7.4.
- **A test pyramid** — Vitest + React Testing Library + MSW for hooks
  and components, Playwright for end-to-end smoke flows, and Storybook
  with axe-core a11y assertions for component-driven development per §10.
- **Two parity tests** — `every-event-has-handler.test.ts` and
  `every-stage-state-has-badge.test.ts` per §7.4 / §10.2 — that mirror
  the backend's `scripts/check-domain-type-parity.py` discipline at the
  frontend boundary.
- **Documentation** updates across `architecture.md`, `decisions.md`,
  `local-development.md`, `local-ts-api.md`, `local-reliability-qa.md`,
  `AGENTS.md`, `INDEX.md`, and `delivered.md`; new ADRs for the
  TanStack-family adoption, the SSE realtime contract, the frontend
  hexagonal ports, and the View-vs-Context dichotomy.

### What This Plan Explicitly Defers

The frontend target's §9 names every cloud adapter as **named-not-built**.
This plan therefore ships the local-mode adapters with their seams in
place; it does **not** implement:

- **TanStack Start** (SSR / RSC). The Vite SPA stays. Trigger:
  `frontend-target.md` §9.1 / §9.2 fitness functions.
- **`JwtSessionAdapter`** (Auth0 / Cognito). `LocalSessionAdapter`
  returns `LOCAL_TENANT`. Trigger: §9.3 fitness function ("API exposed
  beyond `127.0.0.1`").
- **Tenant-scoped routing** (`/t/$tenantId/*` prefix + tenant switcher).
  Query keys already start with `tenant`; route prefix waits for §9.4.
- **`OpenTelemetryWebAdapter`**. `ConsoleTelemetryAdapter` is the local
  no-op. Trigger: §9.5 SOC2 / GDPR requirement.
- **CDN cache headers / edge caching.** Local hits `127.0.0.1`. Trigger:
  §9.6 latency fitness function.
- **`@tanstack/query-sync-storage-persister` IndexedDB persistence.**
  In-memory cache only. Trigger: §9.7 fitness function.
- **`WebSocketEventStreamAdapter`.** SSE only. Trigger: §9.8 SSE
  proxy-drop or duplex-required fitness function.
- **Any feature flag.** `StaticFeatureFlagAdapter` returns defaults; the
  port exists, no flags ship. Trigger: §9 / target §6.1 question 15.
- **`ImportJobUseCase`, `useEnrichmentRetryMutation`,
  `useCorrectScoreMutation`.** These hooks have **placeholder files** so
  their context folders have unambiguous homes (target §3.2, §3.3, §3.5
  notes), but the backend endpoints do not exist yet — the placeholders
  throw `NotImplementedError` at call time and have no UI surface.
- **Visual design tokens, copy, iconography choices.** `tokens.css`
  exists with placeholders; design owns the values (target §1
  Non-Goals).
- **Internationalization.** Single user, English-only (target §1
  Non-Goals).
- **Native / Tauri / Electron wrappers.** Port discipline keeps it
  unblocked (target §1 Non-Goals).
- **JobId migration.** `apps/api` still accepts `jobKey: string`; the
  ACL maps `JobId → jobKey` at the boundary per target §6.5 / R13. The
  rename lands when the backend exposes `JobId` in the API surface.

Anything **not** named in `docs/frontend-target.md` is also out of scope
(target §15: "What This Doc Does Not Decide" enumerates the structural
boundary).

---

## 2. Plan Principles

JobHunter has exactly one user. There is no other consumer whose UI
state, deep links, browser cache, or workflows must be preserved across
a migration. Every step here is **rip-and-replace** per
[`feedback_no_strangler.md`](../../../.claude/projects/-Users-eloibarti-Github-JobHunter/memory/feedback_no_strangler.md):
the new implementation lands in the same change that deletes the old
one.

1. **One PR per step, with explicit "cut-over" steps marking the
   rip-and-replace boundary.** Steps are classified as either
   **preparation** (introduces target constructs that have no live
   consumer yet — the app builds and works because nothing references
   the new code; the legacy code path is untouched) or **cut-over**
   (rewires consumers to the new constructs and DELETES the legacy
   code path in the same commit). Preparation steps land as separate
   PRs for reviewability; cut-over steps land in a single PR that
   contains both the rewire and the deletion. This mirrors the DDD
   plan's per-step-PR cadence and AGENTS.md's "small reviewable PRs"
   rule, while preserving no-strangler discipline (preparation code
   compiles but is unreached, which is *not* strangler — strangler is
   "wrap the old behavior to be replaced gradually"; this is "ship the
   new construct, then in one cut-over PR rewire and delete").

   **Cut-over steps in this plan:**

   | Step | Phase | Cut-over scope |
   |---|---|---|
   | S-06 | 1 | AppShell hosts legacy view bodies; deletes inline theme `useState` + `localStorage` ceremony AND the entire legacy `<header>` (App.tsx:124-171). |
   | S-09 | 2 | Per-route view split; deletes `useState<View>`, monolithic `App.tsx`, and every `window.dispatchEvent("jobhunter:set-jobs-filter", ...)` site. |
   | S-15 | 3 | Rewires every view to hooks; deletes every `useState<DataShape>` + `useEffect(load)` + `useRef(0)` (`requestSeq`) block + every sibling-loader callback + every URL-state `useState` (`<JobSortField>`, `<Direction>`, `<page>`, `<pageSize>`, filter `useState`s). |
   | S-17 | 4 | TanStack Table v8 in JobsTable + ArtifactsTable; deletes hand-rolled sort/select-page/select-all/pagination JSX. |
   | S-18 | 4 | TanStack Form for Profile + Settings + Credentials + Wizard step forms; deletes per-field `useState` draft trees. |
   | S-20 | 5 | Real `SseEventStreamAdapter`; deletes the Phase 1 stub adapter; populates the invalidation router (Phase 3 shipped the empty handler map). |

   **Preparation steps** are S-01..S-05, S-07, S-08, S-10..S-14, S-16,
   S-19, S-21..S-28. Each ships in its own PR; the app builds and
   works after each merge because the new construct has no live
   consumer yet.

2. **One PR per step (preparation or cut-over); conventional commits.**
   PR titles follow conventional commits per AGENTS.md
   (`feat(web): S-NN <summary>`, `chore(web): S-NN <summary>`,
   `refactor(web): S-NN <summary>`, `feat(api): S-NN <summary>`,
   `docs(web): S-NN <summary>`). The legacy DELETION half of a
   cut-over PR is named in the title (e.g.,
   `refactor(web): S-15 — rewire views to hooks; delete useState/useEffect/useRef-requestSeq + sibling-loader callbacks`).
   Per §10, branch naming is `web/s-NN-<short-name>`. PRs within a
   phase stack on each other (S-10 → S-11 → S-12 → ...); PRs across
   phases stack on the previous phase's last merged step. The
   ship-each-PR-green invariant from §2 principle 4 is the gate at
   every PR, not just at phase boundaries.
3. **Rip-and-replace, no strangler.** Every phase that introduces a
   target construct DELETES the legacy construct in the same commit.
   Specifically:
   - Phase 1 DELETES the inline `useState<Theme>` + `localStorage`
     ceremony in `App.tsx:63-66, 95-98`.
   - Phase 2 DELETES the `useState<View>("dashboard")` switcher in
     `App.tsx:61, 178-194`, the monolithic `App.tsx`, and every
     `window.dispatchEvent(new CustomEvent("jobhunter:..."))` site
     (App.tsx:102, 410-430).
   - Phase 3 DELETES every `useState<DataShape>` + `useEffect` +
     `useRef(0)` (`requestSeq`) plumbing block (canonical case:
     `App.tsx:374-403`), every manual sibling-loader callback (e.g.,
     `await Promise.all([load(), onJobsChanged()])` at `App.tsx:518`),
     and every per-component fetch dependency (the `useCallback` dep
     array fetch reload pattern).
   - Phase 4 DELETES the hand-rolled sort/select-page/select-all/
     pagination logic in `JobsView` (`App.tsx:441-493, 599-651`) and
     `ArtifactsView`, and the `useState`-per-field draft tracking in
     `ConfigView` / `ProfileView` (canonical case: `App.tsx:813`).
   - Phase 5 DELETES the no-realtime gap: every cache becomes
     event-driven; `refetchOnWindowFocus` becomes the backstop, not the
     primary freshness mechanism.
4. **Working, deployable app after every phase.** No "ship a broken UI
   now, fix in next phase." Each phase's Acceptance Criteria includes
   "the app builds (`pnpm web:build`), type-checks
   (`pnpm web:check`), lints, runs (`pnpm web:dev`), and every
   previously-working flow still works manually per
   `docs/local-reliability-qa.md`." A phase that cannot meet this gate
   is not landed; it is split into a smaller phase that can.
5. **Evolutionary architecture.** Cloud-mode adapters are
   **named-not-built** per target §9. Every port introduced in this
   plan exists with its local adapter wired and its hosted-mode adapter
   documented but not implemented. Fitness functions trigger evolution,
   not calendar dates.
6. **Ubiquitous language with the target.** The plan uses the target
   doc's terms verbatim — `JobId`, `Stage`, `StageState`, `MaterialsSet`,
   `Generation`, `ArtifactStatus`, `ApplyRun`, `EventStreamPort`,
   `InvalidationRouter`, `ProjectionTypedHook`, `LOCAL_TENANT`. No
   frontend-invented synonyms. Where the API client still uses a
   transport-level term (`jobKey`), the frontend calls it `JobId` and
   the ACL (target §6.5) is the single mapping site (target R13).
7. **Eight contexts, three views.** The plan builds all eight context
   folders even when their UI surface is thin (Discovery and Enrichment
   ship with placeholder hooks per target §3.2 / §3.3). Views do not
   own queries, mutations, or stores; they own layout, URL binding,
   and view-local ephemeral state per target §3.10 / §4.5.
8. **Mirror the backend.** The frontend's bounded contexts are a
   conformist projection of the backend's contexts (target §3). The
   plan does not introduce any frontend domain concept that does not
   trace to a backend bounded context.
9. **Tenant-first-now, not tenant-later.** Every query key starts with
   `["tenant", tenantId, ...]` from Phase 3 onward (target §4.1
   resolution to question 10). `useTenantId()` returns `LOCAL_TENANT`
   today; no code path is "tenant-less" awaiting cloud cutover.
10. **Strict TypeScript adoption.** `exactOptionalPropertyTypes: true`
    and `noUncheckedIndexedAccess: true` are enabled in Phase 1 (target
    §2.5); the resulting compile errors are fixed in the same phase
    rather than suppressed. No new `any` in feature code.
11. **No `window.dispatchEvent` cross-component coordination.** Replaced
    by URL navigation, Zustand stores, and the query cache + SSE
    invalidation router. CI grep guard fails the build if the pattern
    reappears (target R6).

### Sequencing Justification

The orchestrator's recommended phase order is:

> Foundation → Router → Query → Table+Form → Realtime → Testing →
> Storybook → Documentation.

This plan adopts that order with **one explicit deviation**: a
**Phase 0 (Pre-flight)** is added before Phase 1 to make the
preconditions explicit (clean main, modeling doc accepted, dependency
versions resolved, current `App.tsx` committed for reference). Phase 0
contains no code changes; it is a checklist gate.

The rationale for the Foundation → Router → Query order (not, e.g.,
Router → Query → Foundation):

- **Foundation first** establishes the visual primitive layer
  (Tailwind, shadcn) and the Zustand+context state primitives. The
  AppShell that hosts every subsequent route lives here. Without this,
  Phase 2 would have to introduce both the router *and* the styling
  system in one change.
- **Router before Query.** Routes own typed search params; search
  params drive query keys (target §5.2). Putting Query before Router
  would force every query-key factory to accept `useState`-derived
  filter values temporarily, which would later be rewritten when the
  router lands. Router-first means the search-param schemas are the
  query-key inputs from day one.
- **Query before Table/Form.** TanStack Table's column models receive
  data from `useQuery` results; Table-first would couple the table
  refactor with hand-rolled fetch plumbing.
- **Realtime after Query.** The SSE consumer's only output is to the
  Query cache (`invalidateQueries` / `setQueryData`). Realtime cannot
  ship before the cache exists.
- **Testing harness after Realtime.** The harness must cover the
  invalidation router (the most important unit test in the app per
  target §10.2). Shipping the harness before the router exists would
  produce a partial test surface; shipping after means the parity tests
  catch the router from day one.
- **Storybook last (before docs).** Storybook stories depend on the
  components, primitives, and MSW handlers from prior phases. Putting
  Storybook earlier would require backfilling stories whenever a
  component changes shape.
- **Documentation last.** All structural decisions are concrete by
  Phase 7; docs codify them and move this plan to `implemented/`.

---

## 3. Pre-flight Checks

Before Phase 1's first commit:

- [ ] `main` is clean and up to date
  (`git fetch origin main && git switch main && git pull --ff-only`).
- [ ] `pnpm test` passes on `main`.
- [ ] `pnpm web:build` and `pnpm web:check` pass on `main`.
- [ ] `uv --project workers/automation run --extra dev pytest -q` passes on `main`.
- [ ] `uv --project workers/automation run --extra dev ruff check .` passes on `main`.
- [ ] `git diff --check` is clean.
- [ ] `docs/frontend-target.md` is merged to `main` and is the
  contract — no in-flight PR modifies it during this migration. If a
  target change becomes necessary mid-migration, pause this plan, ship
  the target change, then resume.
- [ ] Team has read `docs/frontend-target.md` end to end.
- [ ] Team has read this plan end to end.
- [ ] This plan is reviewed and merged to `main` under
  `docs/plans/proposed/frontend-tanstack-migration.md` before Phase 1
  begins. The plan moves to `docs/plans/implemented/` in Phase 8 (S-29).
- [ ] `pnpm-lock.yaml` is current with the existing dependency graph
  (`pnpm install --lockfile-only` produces no diff).
- [ ] Node.js version is `>=20.19.0` (per
  `docs/decisions.md` 2026-05-02 / `apps/web` runtime requirement).
- [ ] The local API (`pnpm api:dev`) and the local web (`pnpm web:dev`)
  both boot against a fresh `~/.jobhunter` directory; the dashboard
  loads and shows the seeded jobs / artifacts.

**Recovering the legacy `App.tsx` post-Phase-2.** The Phase 2 deletion
is in git history; no special anchor is needed. To inspect the
legacy file after deletion:
```bash
git log --all --full-history -- apps/web/src/App.tsx
git show <sha>:apps/web/src/App.tsx
```

If any pre-flight check fails, fix it before Phase 1 starts. Phase 0
contains no code changes; this is a gate, not a deliverable.

---

## 4. Phase Breakdown

### Phase 0: Pre-flight

| Attribute | Value |
|---|---|
| **Theme** | Establish the gate that lets Phase 1 start. No code changes. |
| **Target sections** | All — phase establishes the contract. |
| **Exit criteria** | Section 3 checklist all green; this plan merged under `docs/plans/proposed/`. |
| **Effort** | Trivial — checklist verification. |
| **Dependencies** | None. |
| **PRs** | None — this is a gate, not a delivery. |

### Phase 1: Foundation — Visual Primitives, Stores, Ports, AppShell

| Attribute | Value |
|---|---|
| **Theme** | Lay the visual + cross-cutting-state + ports foundation that every later phase mounts on top of. The legacy `App.tsx` view switcher is still in place; theme/density/toasts are now driven by Zustand+persist; the new `AppShell` wraps the legacy views. |
| **Target sections** | §2.5 (strict TS), §4.7 (shadcn), §4.8 (Tailwind), §4.9 (Zustand vs context split), §4.10 (theme/density), §4.11 (error handling — toast store), §6 (ports), §11 (`shared/`). |
| **Exit criteria** | App boots; `pnpm web:dev` shows the existing five views inside the new `AppShell` (Topbar / NavBar / ThemeToggle / ConnectionStatusPill placeholder); the theme toggle is driven by `useUiPreferencesStore` (Zustand+persist), not the inline `App.tsx` `useState<Theme>` (which is **deleted in this phase**); shadcn primitives are present in `shared/ui/`; ports interfaces and local adapters compile and are wired through `<PortsProvider>`; `pnpm web:check` and `pnpm web:build` pass; `tsconfig.json` has `exactOptionalPropertyTypes: true` and `noUncheckedIndexedAccess: true`. |
| **Effort** | Medium — new dependency baseline, ~30 shadcn primitive files, Zustand stores, ports + local adapters, `AppShell` chrome. No view extraction yet. |
| **Dependencies** | Phase 0 pre-flight. |
| **PRs** | Six PRs (one per step) — see §10 Branching Convention. Cut-over step in this phase: **S-06** (deletes the legacy `<header>` and the inline theme `useState` ceremony). |

### Phase 2: Router — File-Based Routes & Per-Route View Split

| Attribute | Value |
|---|---|
| **Theme** | Replace the `useState<View>` switcher with TanStack Router (file-based, Vite plugin), split the legacy `App.tsx` monolith into one file per view under `views/`, and bind URL state (typed via Zod) to filters / sort / pagination / drawer-open across every view. |
| **Target sections** | §2.1 (URL state), §2.5 (route-level Zod), §4.3 (route shapes), §4.4 (per-context routes), §11 (`routes/` + `views/`). |
| **Exit criteria** | Every previous view has a route under `routes/`; `useState<View>` is **deleted**; `apps/web/src/App.tsx` is rewritten to mount `<RouterProvider>` and is < 50 LOC; the original 2,527-line `App.tsx` is **deleted from `main`** (recoverable via `git log --all --full-history -- apps/web/src/App.tsx`); refresh stays on the current view; deep links work for `/jobs/$jobId` and `/artifacts/$artifactId`; the resume-import wizard is a nested route (`/profile/import/{upload,preview,confirm}`); every `window.dispatchEvent(new CustomEvent("jobhunter:..."))` site is **deleted** (the dashboard-KPI → jobs-filter-prefill flow is replaced by `navigate({ to: "/jobs", search: { state: "failed" } })`); `pnpm web:dev` works manually for every previous flow. |
| **Effort** | Large — 2,527 LOC App.tsx is split into ~25 files across `routes/` and `views/`. |
| **Dependencies** | Phase 1 (AppShell / shared/ui / providers). |
| **PRs** | Three PRs (one per step) — see §10 Branching Convention. Cut-over step in this phase: **S-09** (deletes `useState<View>`, the monolithic `App.tsx`, and every `window.dispatchEvent` site). |

### Phase 3: Query — Per-Context Hooks, Keys, Ports, EventStream Scaffolding

| Attribute | Value |
|---|---|
| **Theme** | Replace every per-view `useState<DataShape>` + `useEffect` + `useRef(0)` (`requestSeq`) plumbing with TanStack Query v5. Introduce the per-context query-key factories (with `tenant` as first segment), the `ApiClientPort` wrapping `@jobhunter/api-client`, the per-aggregate-context mutation hooks, and the SSE plumbing scaffold (port + provider + invalidation router) — but no real SSE wire yet (the adapter is a stub that exposes `status: "stub"`). |
| **Target sections** | §2.1 (server state), §2.4 (data orientation), §4.1 (query keys), §4.2 (hook conventions), §4.4 (per-context tactical spec), §4.11 (error handling), §5.2 (URL ↔ cache binding), §5.3 (optimistic updates), §5.4 (stale time / GC), §6 (ApiClientPort, EventStreamPort), §7.3 (EventStreamProvider scaffold), §7.4 (invalidation router scaffold — empty handler set), §8.2 (mutation invalidation map). |
| **Exit criteria** | All previous loads use `useQuery` (Operations) hooks; mutations use `useMutation` hooks owned by the aggregate context per target §4.4; the canonical `requestSeq`+`useState`+`useEffect` block in `JobsView` (App.tsx:374-403 equivalent in the now-split files) is **deleted everywhere**; `await Promise.all([load(), onJobsChanged()])`-style sibling reloads (App.tsx:518) are **deleted everywhere** (replaced by `queryClient.invalidateQueries(jobsKeys.lists(tenantId))` and `dashboardKeys.summary(tenantId)`); the connection-status pill renders "stub" until Phase 5; `pnpm web:dev` works manually for every previous flow; `staleTime` defaults match target §5.4. |
| **Effort** | Large — 7+ context folders populated, ~20 hooks, ~8 query-key factories, ports + adapters, invalidation-router scaffold. |
| **Dependencies** | Phase 2 (routes/views split provides the file homes for the hook calls). |
| **PRs** | Seven PRs (one per step) — see §10 Branching Convention. Cut-over step in this phase: **S-15** (rewires every view to hooks; deletes every `useState<DataShape>` + `useEffect(load)` + `useRef(0)` block + every URL-state `useState`). |

### Phase 4: Table + Form — TanStack Table v8, TanStack Form

| Attribute | Value |
|---|---|
| **Theme** | Replace the hand-rolled sort / select-page / select-all / pagination logic in `JobsView` and `ArtifactsView` with TanStack Table v8 column models. Replace the per-field `useState` + manual draft/original tracking in `ConfigView` and `ProfileView` with TanStack Form (Zod resolvers). The resume-import wizard's *step routing* is already nested-route from Phase 2; this phase makes each step's *form* a TanStack Form with shared draft state in `profileImportStore`. |
| **Target sections** | §4.5 (view composition — JobsTable / ArtifactsTable), §4.6 (forms), §3.4 / §4.4.4 (Profile + wizard). |
| **Exit criteria** | `JobsTable.tsx` and `ArtifactsTable.tsx` use TanStack Table v8; the hand-rolled sort buttons / select-page / select-all / pagination JSX is **deleted**; profile, settings, credential, and resume-import-step forms use TanStack Form; per-field `useState` draft trees are **deleted**; the resume-import wizard's draft state lives in the `profileImportStore` (Zustand+persist); `pnpm web:dev` and full QA manual matrix pass. |
| **Effort** | Medium-large — table column models + cell renderer composition from contexts; ~6 forms. |
| **Dependencies** | Phase 3 (hooks return the data the table consumes). |
| **PRs** | Two PRs (one per step) — see §10 Branching Convention. **Both steps are cut-over**: **S-17** (deletes hand-rolled sort/select/pagination JSX) and **S-18** (deletes per-field `useState` draft trees). |

### Phase 5: Realtime — Backend SSE Endpoint + Frontend Consumer

| Attribute | Value |
|---|---|
| **Theme** | Implement the new `GET /v1/events/stream` endpoint on `apps/api/` per target §7.1 (Fastify SSE, Last-Event-ID, keepalive, heartbeat, tenant scope, `X-Accel-Buffering: no`). Wire the frontend `SseEventStreamAdapter` to the real endpoint, replace the Phase 3 stub, populate the invalidation router's handler map (one handler per backend `DomainEvent` variant), and let the dashboard / drawers update live. Use `setQueryData` for `ApplyRunEventRecorded` (high-frequency append); `invalidateQueries` for everything else. Add the connection-status / reconnect / 30s "connection lost" banner per §7.7. |
| **Target sections** | §3.9 (Operations: SSE subscription + invalidation router), §4.4.1 (Operations queries), §7 (entire realtime section), §8.4 (event → invalidation map). |
| **Exit criteria** | `apps/api/src/server.ts` exposes `GET /v1/events/stream` with the contract from target §7.1; the frontend `SseEventStreamAdapter` opens an `EventSource` to it on mount; triggering an apply action updates the dashboard / job drawer / artifacts list within ≤ 1s without manual refresh; killing the API process flips the connection-status pill to "reconnecting" within ≤ 30s and back to "live" on restart; on reconnect, the provider runs a one-shot full `queryClient.invalidateQueries()` backstop per target §7.7; the Phase 3 stub adapter is **deleted**; `pnpm web:dev` and `pnpm api:dev` work end-to-end. |
| **Effort** | Medium-large — backend endpoint design + Fastify SSE handler + frontend adapter + ~27 invalidation handlers. |
| **Dependencies** | Phase 3 (Query cache, ports, invalidation-router scaffold). |
| **PRs** | Two PRs (one per step) — see §10 Branching Convention. Cut-over step in this phase: **S-20** (replaces the Phase 1 stub `SseEventStreamAdapter` and populates the empty handler map shipped in S-16). |

### Phase 6: Testing Harness — Vitest, RTL, MSW, Playwright, Parity Tests

| Attribute | Value |
|---|---|
| **Theme** | Build the test pyramid from target §10. Vitest + React Testing Library + MSW for unit, hook, and component tests; Playwright for end-to-end smoke flows; the **two parity tests** (`every-event-has-handler.test.ts` and `every-stage-state-has-badge.test.ts`) per target §7.4 / §10.2; `tsd` for type-level assertions on hook return shapes; `axe-core` for form/dialog a11y spot-checks. |
| **Target sections** | §10 (entire testing strategy), §7.4 (event-handler parity test), §2.4 (exhaustive `switch` → stage-state parity test). |
| **Exit criteria** | `pnpm web:test` runs Vitest unit + integration; the invalidation-router unit test asserts the exact `invalidateQueries` / `setQueryData` set per backend event (target §10.2 "the most important unit test in the app"); the `every-event-has-handler.test.ts` parity test fails CI if any `DomainEvent["type"]` variant lacks a registered handler or registers an obvious empty stub; the `every-stage-state-has-badge.test.ts` parity test fails CI if any `STAGE_STATE_KINDS` value lacks a `<StageBadge>` arm; one MSW-backed hook test exists per query and per mutation hook; one Playwright spec exists per critical flow (target §10.4 — eight flows); `tsd` type tests cover the eight Operations read hooks; `axe-core` runs on form / dialog component tests; CI runs all three layers. |
| **Effort** | Large — 0 → comprehensive test pyramid. |
| **Dependencies** | Phase 5 (the SSE consumer is the most important thing to test; without it, the parity tests cannot fully assert). |
| **PRs** | Five PRs (one per step) — see §10 Branching Convention. No cut-over steps in this phase (all preparation: tests are pure additions). |

### Phase 7: Storybook — Per-Primitive + Per-Context Stories + a11y Baseline

| Attribute | Value |
|---|---|
| **Theme** | Add Storybook with the MSW addon and the a11y addon; ship a story per shadcn primitive in `shared/ui/`, a story per domain component in each context (`<ScoreBadge>`, `<StageBadge>`, `<StageTimeline>`, `<ApplyRunBadge>`, `<ApplyRunTimeline>`, `<JobActions>`, `<GenerateMaterialsButton>`, `<OpenArtifactButton>`), and a story per view (`<DashboardView>`, `<JobsView>`, `<JobDetailDrawer>`, `<ArtifactsView>`, `<ProfileEditor>`, `<ResumeImportWizard>`). Visual regression (Chromatic or Loki) is **named-not-built** — stories are the input, the snapshotter swap is a one-line CI change when the user wants visual regression. |
| **Target sections** | §10.5 (Storybook), §10.7 (a11y spot-checks). |
| **Exit criteria** | Storybook runs locally (`pnpm web:storybook`); stories build in CI (`pnpm web:storybook:build`); the MSW addon supplies fake API responses to story states (loading / populated / empty / error); the a11y addon reports zero **critical** axe violations on every form and dialog story; the visual-regression snapshotter is **named in the README** but no Chromatic project / Loki repo is wired. |
| **Effort** | Medium — Storybook scaffold + ~50 stories. |
| **Dependencies** | Phase 4 (forms + tables exist), Phase 5 (live data shapes exist for stories), Phase 6 (MSW handlers exist for stories to import). |
| **PRs** | Two PRs (one per step) — see §10 Branching Convention. No cut-over steps in this phase (all preparation: Storybook is a pure addition). |

### Phase 8: Documentation, ADRs, Glossary, Plan Move

| Attribute | Value |
|---|---|
| **Theme** | Comprehensive doc sweep. Update `architecture.md`, `local-development.md`, `local-ts-api.md`, `local-reliability-qa.md`, `AGENTS.md`, `INDEX.md`, `delivered.md`, `backlog.md`. Add four new ADRs to `decisions.md`. Move this plan from `docs/plans/proposed/` to `docs/plans/implemented/`. |
| **Target sections** | All — docs codify the implemented state. |
| **Exit criteria** | Every doc reflects the post-migration state; four new ADRs accepted; `INDEX.md` mentions `docs/frontend-target.md`; this plan is at `docs/plans/implemented/<merge-date>-frontend-tanstack-migration.md`; `docs/delivered.md` records each phase PR; `docs/backlog.md` lists every cloud-mode adapter (target §9) with its fitness function. |
| **Effort** | Small — pure documentation. |
| **Dependencies** | Phases 1–7. |
| **PRs** | One PR (S-28) — see §10 Branching Convention. Cut-over: this PR also moves the plan from `docs/plans/proposed/` to `docs/plans/implemented/<merge-date>-frontend-tanstack-migration.md`. |

---

## 5. Step-by-Step Plan

Step IDs continue across phases (`S-01`..`S-28`). Each step lands as
its own PR per §2 principle 1 and §10 Branching Convention.
**Cut-over** steps (S-06, S-09, S-15, S-17, S-18, S-20) ship the new
construct *and* delete the legacy code path in the same PR;
**preparation** steps ship the new construct alone (no live consumer
yet — the app builds and works because nothing references the new
code; the next cut-over step rewires consumers and deletes the
legacy path).

### Phase 0: Pre-flight

This phase has no steps. Verification only. Section 3 is the checklist.

When every box in §3 is green, Phase 1 starts.

---

### Phase 1: Foundation — Visual Primitives, Stores, Ports, AppShell

**Motivation.** The frontend has zero Tailwind, zero shadcn, zero
component primitives, zero Zustand, zero ports. Every later phase
assumes these exist. Standing them up first means Phase 2 (Router) only
adds routing, Phase 3 (Query) only adds data, etc., rather than each
phase carrying foundation work.

**Scope.** New dependency baseline; `tailwind.config.ts` + `tokens.css`
+ `globals.css` (replacing the existing CSS-variable-driven
`apps/web/src/styles.css`); shadcn primitives copied into
`shared/ui/`; `lucide-react` icons; Zustand stores; shared hooks; ports
interfaces and local adapters; provider stack; `AppShell` chrome
hosting the existing legacy view switcher.

**Sequenced steps.** The legacy `App.tsx` view switcher and the legacy
view bodies (`Dashboard`, `JobsView`, `ArtifactsView`, `ConfigView`,
`ProfileView`) **stay in place** during this phase — they are wrapped
by the new shell. The inline `useState<Theme>` + `localStorage`
ceremony at `App.tsx:63-66, 95-98` IS deleted in S-06 (replaced by
Zustand). The view extraction itself is Phase 2.

---

#### S-01: chore(web): pin dependency baseline + add Tailwind 4 + tokens + globals

| Attribute | Detail |
|---|---|
| **Phase** | 1 — Foundation |
| **Frontend area** | Build / styling foundation |
| **Target sections** | §2.5 (strict TS), §4.8 (Tailwind). |

**Files touched:**

- `apps/web/package.json` — **refactor** add `tailwindcss@^4`,
  `@tailwindcss/vite`, `tailwind-merge`, `clsx`, `class-variance-authority`,
  `zod` (zod will be used in Phase 2 + Phase 3; pinned now to keep one
  dependency-baseline commit per phase).
- `apps/web/vite.config.ts` — **refactor** add `@tailwindcss/vite` plugin.
- `apps/web/tailwind.config.ts` — **new** consume design tokens; configure
  `darkMode: ["selector", "[data-theme='dark']"]` per target §4.8.
- `apps/web/src/styles/tokens.css` — **new** initial-bootstrap CSS
  variable values copied verbatim from the existing
  `apps/web/src/styles.css` (preserving visual parity in Phase 1).
  Target §1 Non-Goals applies to the *eventual* token values
  (design owns those when design opts in); the initial bootstrap is
  whatever `styles.css` ships today.
- `apps/web/src/styles/globals.css` — **new** Tailwind directives +
  `@layer base` rules (background, text color, focus rings).
- `apps/web/src/styles.css` — **deleted** (its CSS-variable-driven theming
  is replaced by `tokens.css` + `globals.css`).
- `apps/web/src/main.tsx` — **refactor** import `./styles/globals.css`.
- `apps/web/tsconfig.json` — **refactor** enable
  `exactOptionalPropertyTypes: true` and `noUncheckedIndexedAccess: true`
  per target §2.5; fix any compile errors that surface in `App.tsx`
  in-place (do NOT add `// @ts-expect-error`; do NOT loosen the
  options).
- `pnpm-lock.yaml` — regenerated.

**Approach.** Tailwind 4 (the `@tailwindcss/vite` plugin) is the
modern install path; v4 ships token-driven theming via CSS custom
properties without a JS config for the token values themselves. The
existing `styles.css` is deleted in this step; its CSS-variable
declarations are reorganized into `tokens.css` (raw values) and
`globals.css` (Tailwind directives + base layer). `App.tsx` is **not**
restyled in this step — its existing `className` attributes remain
valid because `globals.css` continues to provide the same base CSS;
the substantive Tailwind utility-class adoption happens in S-06 when
the AppShell lands and in the per-view files in Phase 2.

The strict-TS adoption (`exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`) surfaces compile errors that get fixed in
this step. Per target R5, this is part of the same change that adopts
the new architecture; there is no parallel old/new strict path.

**Tenancy implications.** None.

**Acceptance:**

- `pnpm web:check` passes.
- `pnpm web:build` produces a working bundle.
- `pnpm web:dev` boots the existing app; visual appearance is
  unchanged.
- `tsconfig.json` shows `"exactOptionalPropertyTypes": true` and
  `"noUncheckedIndexedAccess": true`.

**QA checklist:** load each existing view (dashboard, jobs, artifacts,
config, profile); confirm visual parity with `main`.

**Deferred follow-ups:** Tailwind utility-class adoption inside the
view bodies — happens incrementally in Phase 2's per-view files.

---

#### S-02: feat(web): copy shadcn/ui primitives + lucide-react icons

| Attribute | Detail |
|---|---|
| **Phase** | 1 — Foundation |
| **Frontend area** | UI primitives |
| **Target sections** | §4.7 (shadcn / Radix decision), §4.8 (Tailwind binding). |

**Files touched:**

- `apps/web/package.json` — **refactor** add `lucide-react` and the
  Radix peer-dependencies that shadcn primitives import
  (`@radix-ui/react-dialog`, `@radix-ui/react-dropdown-menu`,
  `@radix-ui/react-select`, `@radix-ui/react-tabs`, `@radix-ui/react-tooltip`,
  `@radix-ui/react-checkbox`, `@radix-ui/react-switch`,
  `@radix-ui/react-popover`, `@radix-ui/react-toast`,
  `@radix-ui/react-slot`, `@radix-ui/react-label`).
- `apps/web/components.json` — **new** shadcn CLI config (style: default,
  rsc: false, tailwind config: `./tailwind.config.ts`, aliases pointing
  at `./src/shared/ui` and `./src/shared/lib`).
- `apps/web/src/shared/ui/button.tsx` — **new**.
- `apps/web/src/shared/ui/dialog.tsx` — **new**.
- `apps/web/src/shared/ui/drawer.tsx` — **new**.
- `apps/web/src/shared/ui/sheet.tsx` — **new**.
- `apps/web/src/shared/ui/dropdown-menu.tsx` — **new**.
- `apps/web/src/shared/ui/select.tsx` — **new**.
- `apps/web/src/shared/ui/command.tsx` — **new**.
- `apps/web/src/shared/ui/tabs.tsx` — **new**.
- `apps/web/src/shared/ui/toast.tsx` — **new**.
- `apps/web/src/shared/ui/toaster.tsx` — **new**.
- `apps/web/src/shared/ui/tooltip.tsx` — **new**.
- `apps/web/src/shared/ui/skeleton.tsx` — **new**.
- `apps/web/src/shared/ui/input.tsx` — **new**.
- `apps/web/src/shared/ui/textarea.tsx` — **new**.
- `apps/web/src/shared/ui/checkbox.tsx` — **new**.
- `apps/web/src/shared/ui/switch.tsx` — **new**.
- `apps/web/src/shared/ui/badge.tsx` — **new**.
- `apps/web/src/shared/ui/card.tsx` — **new**.
- `apps/web/src/shared/ui/form.tsx` — **new** (TanStack Form bindings
  arrive in Phase 4; this file ships with the field/label primitives now
  and gets the TanStack Form `useFieldContext` wiring later).
- `apps/web/src/shared/ui/table.tsx` — **new** primitives consumed by
  TanStack Table in Phase 4.
- `apps/web/src/shared/ui/copyable-command.tsx` — **new** preserves the
  copyable-CLI affordance per `decisions.md` 2026-05-03 and target
  §3.8 / §13 glossary.
- `apps/web/src/shared/lib/cn.ts` — **new** `cn(...inputs)` =
  `twMerge(clsx(...))`.

**Approach.** Run the shadcn CLI to scaffold each primitive into
`shared/ui/`. The CLI copies source files directly (no upstream
runtime dependency); we own the components per target §4.7 ("we own
the components"). Each file is the canonical shadcn output with
minor Tailwind class adjustments to match the placeholder tokens in
`tokens.css`. `lucide-react` is the icon source; no other icon
dependency is added (target §4.7).

`copyable-command.tsx` is **not** a shadcn upstream primitive — it is
a JobHunter-local `shared/ui/` helper that preserves the
"copyable commands stay" affordance recorded in `docs/decisions.md`
2026-05-03 and named in target §3.8 and §13 glossary. Buttons call
structured mutations; the copyable strip remains for transparency
and manual debugging.

**Tenancy implications.** None.

**Acceptance:**

- `pnpm web:check` passes.
- `pnpm web:build` succeeds.
- The primitives are importable from `apps/web/src/shared/ui/<name>`.
- They are not yet *used* by `App.tsx` — they exist for Phase 1's
  later steps and Phase 2 onward.

**QA checklist:** none — no behavioral change.

**Deferred follow-ups:** every primitive's first real consumer in
later phases.

---

#### S-03: feat(web): add Zustand stores + shared hooks (ui-preferences, toasts, command-palette stub)

| Attribute | Detail |
|---|---|
| **Phase** | 1 — Foundation |
| **Frontend area** | Cross-cutting client state |
| **Target sections** | §4.9 (Zustand vs context split), §4.10 (theme/density), §4.11 (toast queue), §13 (`ToastQueue`, `CommandPalette` glossary). |

**Files touched:**

- `apps/web/package.json` — **refactor** add `zustand`.
- `apps/web/src/shared/stores/ui-preferences.ts` — **new** Zustand store
  with `persist` middleware (`localStorage` keys `jh:theme`, `jh:density`,
  one `version` field for migrations per target R11).
- `apps/web/src/shared/stores/toasts.ts` — **new** Zustand store: queue
  of `{ id, variant, message, durationMs }`, `toast({ variant, message })`
  imperative API per target §4.11.
- `apps/web/src/shared/stores/command-palette.ts` — **new** Zustand
  store with `open`, `query`, `setOpen`, `setQuery`. The palette UI is
  named-not-built; the store exists so the seam is in place per target
  §13 glossary.
- `apps/web/src/shared/hooks/useTheme.ts` — **new** thin selector over
  `useUiPreferencesStore`.
- `apps/web/src/shared/hooks/useDensity.ts` — **new** same.
- `apps/web/src/shared/hooks/useToast.ts` — **new** thin wrapper exposing
  `toast(...)`.
- `apps/web/src/shared/hooks/useTenantId.ts` — **new** placeholder
  returning `LOCAL_TENANT` from `@jobhunter/domain-types`. The
  tenant-resolution-from-`SessionPort` wiring lands in S-04.

**Approach.** Per target §4.9, the split is: static identity providers
(theme, tenant, query client, router) live behind context; *mutable*
cross-cutting state (theme value, toasts, palette state) lives in
Zustand. The `useTheme()` / `useDensity()` hooks are thin selectors
over the Zustand store; the `<ThemeProvider />` from S-05 wraps them
for ergonomic `useTheme()` consumption per target §13.

The `command-palette` store is shipped now — empty UI, full state
shape — because it appears in `frontend-target.md` §13 glossary and
the orchestrator's "named-not-built" discipline (target §2.3) wants
the seam in place from day one.

The `toast` store's `toast({ variant: "error", message })` API is
called from `QueryCache.onError` in Phase 3 (S-10); landing it now
lets Phase 1's `<Toaster />` wiring be complete before Phase 3
references it.

**Tenancy implications.** `useTenantId()` returns `LOCAL_TENANT` (a
constant from `@jobhunter/domain-types`). The function signature
stays the same when cloud-mode arrives; only the source value
changes (target §4.1).

**Acceptance:**

- `pnpm web:check` passes.
- The stores can be imported and mutated; nothing else uses them yet.

**QA checklist:** none — no UI yet.

**Deferred follow-ups:** S-05 mounts the providers; S-06 wires the
`AppShell` `ThemeToggle` to `useTheme()`.

---

#### S-04: feat(web): define ports + local adapters (Api, EventStream stub, Storage, Session, Clipboard, OpenInOs, Telemetry, FeatureFlag)

| Attribute | Detail |
|---|---|
| **Phase** | 1 — Foundation |
| **Frontend area** | Hexagonal seam |
| **Target sections** | §6 (entire ports section), §6.1–6.5, §13 (per-port glossary). |

**Files touched:**

- `apps/web/src/shared/ports/ApiClientPort.ts` — **new** interface mirroring
  every public method on `JobHunterApiClient` from `@jobhunter/api-client`.
- `apps/web/src/shared/ports/EventStreamPort.ts` — **new** interface
  (`subscribe`, `EventStreamSubscription`, `status`) per target §6.4.
- `apps/web/src/shared/ports/StoragePort.ts` — **new** `get`, `set`,
  `remove` interface scoped to a key prefix.
- `apps/web/src/shared/ports/SessionPort.ts` — **new** `getSession()`
  returning `{ tenantId: TenantId, userId: string | null }`.
- `apps/web/src/shared/ports/ClipboardPort.ts` — **new** `write(text)`.
- `apps/web/src/shared/ports/OpenInOsPort.ts` — **new** `open(artifactId)`.
- `apps/web/src/shared/ports/TelemetryPort.ts` — **new** `event(name, attributes)`,
  `error(error, attributes)`, `timing(name, ms)`.
- `apps/web/src/shared/ports/FeatureFlagPort.ts` — **new** `get<T>(key, defaultValue)`.
- `apps/web/src/shared/ports/adapters/FetchApiClientAdapter.ts` — **new**
  wraps `createJobHunterApiClient(...)` from `@jobhunter/api-client`.
- `apps/web/src/shared/ports/adapters/SseEventStreamAdapter.ts` — **new**
  *stub* (status: "stub"; `subscribe` returns a no-op subscription); the
  real `EventSource` wiring lands in S-21.
- `apps/web/src/shared/ports/adapters/LocalStorageAdapter.ts` — **new**
  prefixes every key with `jh:`.
- `apps/web/src/shared/ports/adapters/LocalSessionAdapter.ts` — **new**
  returns `{ tenantId: LOCAL_TENANT, userId: null }`.
- `apps/web/src/shared/ports/adapters/NavigatorClipboardAdapter.ts` — **new**
  thin `navigator.clipboard.writeText` wrapper.
- `apps/web/src/shared/ports/adapters/OpenArtifactAdapter.ts` — **new**
  POSTs to `/v1/artifacts/:id/open` via the api client.
- `apps/web/src/shared/ports/adapters/ConsoleTelemetryAdapter.ts` — **new**
  no-op + `console.debug` in dev only.
- `apps/web/src/shared/ports/adapters/StaticFeatureFlagAdapter.ts` — **new**
  always returns the supplied default per target §6.1 question 15.

**Approach.** Per target §6.1, every port has a local adapter today
and a hosted-mode adapter named-not-built. The interfaces are defined
to match the hosted-mode shape so the adapter swap is the only thing
that ever changes. `LocalSessionAdapter` returns `LOCAL_TENANT`
unchanged; the hosted `JwtSessionAdapter` is named in target §9.3 and
lands when the API is exposed beyond `127.0.0.1`.

The `SseEventStreamAdapter` is a **stub** in this step — it exposes
`status: "stub"`, `subscribe` returns a subscription whose `on()`
never fires, and `close()` is a no-op. The real `EventSource` wire
lands in Phase 5 (S-20). Stubbing here lets Phase 3's
`EventStreamProvider` be wired through `<PortsProvider />` and lets
the Phase 6 invalidation-router unit tests run against an injectable
fake from day one.

The `OpenInOsPort` adapter is a thin wrapper over the existing
`/v1/artifacts/:id/open` endpoint; no behavior change.

**Tenancy implications.** Every port that needs a tenant scope
(`ApiClientPort`'s hosted-mode header injection, `EventStreamPort`'s
subscribe parameter) accepts `TenantId` at the call site; the
local adapters either ignore it (Api adapter) or use it for
the SSE URL query string in Phase 5 (EventStream adapter).

**Acceptance:**

- `pnpm web:check` passes.
- The port interfaces are exported from `apps/web/src/shared/ports/index.ts`.
- The adapters compile and instantiate.
- Nothing else references them yet (S-05 wires them through the
  provider).

**QA checklist:** none — no UI change.

**Deferred follow-ups:** S-21 replaces the stubbed `SseEventStreamAdapter`
with the real `EventSource` adapter.

---

#### S-05: feat(web): mount provider stack (Ports, Tenant, Theme, Density, Toaster)

| Attribute | Detail |
|---|---|
| **Phase** | 1 — Foundation |
| **Frontend area** | Provider tree |
| **Target sections** | §4.9 (provider split), §4.10 (theme), §6.2 (PortsProvider), §11 (`shared/providers/`). |

**Files touched:**

- `apps/web/src/shared/providers/PortsProvider.tsx` — **new** React context
  exposing `ports.api`, `ports.eventStream`, `ports.storage`,
  `ports.session`, `ports.clipboard`, `ports.openInOs`, `ports.telemetry`,
  `ports.featureFlags`.
- `apps/web/src/shared/providers/TenantProvider.tsx` — **new** reads
  `useSessionPort` (via `usePorts()`), exposes `useTenantId()` (overriding
  the placeholder hook from S-03).
- `apps/web/src/shared/providers/ThemeProvider.tsx` — **new** reads from
  `useUiPreferencesStore`; renders an effect that writes
  `data-theme="dark"` (or `"light"`) on `<html>` per target §4.8 / §4.10.
- `apps/web/src/shared/providers/DensityProvider.tsx` — **new** same
  pattern; writes `data-density="..."` on the AppShell root.
- `apps/web/src/shared/providers/ToasterProvider.tsx` — **new** mounts the
  shadcn `<Toaster />` and subscribes to `useToastStore`.
- `apps/web/src/shared/hooks/useTenantId.ts` — **refactor** read from the
  context (was a placeholder constant in S-03).
- **Provider-location convention (binding for Phase 1, 2, 3):**
  `main.tsx` owns **identity providers** (single instance for the
  app's entire lifetime, independent of route): `<PortsProvider>`,
  `<TenantProvider>`, `<ThemeProvider>`, `<DensityProvider>`,
  `<ToasterProvider>`. `routes/__root.tsx` owns **context-of-route
  providers** (need `<RouterProvider>` to be the parent so router
  context is available): `<QueryClientProvider>` (Phase 3 S-10) and
  `<EventStreamProvider>` (Phase 3 S-16; reads `useTenantId` and
  `useQueryClient` so it sits inside both). This split is documented
  here as the binding pattern for the rest of the migration. No
  Mermaid in the plan to avoid drift; the layered structure is:
  ```
  main.tsx
    <PortsProvider>
      <TenantProvider>
        <ThemeProvider>
          <DensityProvider>
            <ToasterProvider>
              <App />                     ← S-09 changes <App /> to <RouterProvider>
                <RouterProvider>          ← Phase 2 S-09
                  <RouteTree>             ← from routeTree.gen.ts
                    routes/__root.tsx     ← S-08 + S-10 + S-16
                      <QueryClientProvider>
                        <EventStreamProvider>
                          <AppShell>
                            <Outlet />
                          </AppShell>
                        </EventStreamProvider>
                      </QueryClientProvider>
                  </RouteTree>
                </RouterProvider>
            </ToasterProvider>
          </DensityProvider>
        </ThemeProvider>
      </TenantProvider>
    </PortsProvider>
  ```
- `apps/web/src/main.tsx` — **refactor** wrap `<App />` in
  `<PortsProvider>`, `<TenantProvider>`, `<ThemeProvider>`,
  `<DensityProvider>`, `<ToasterProvider>` (in that order: ports first,
  tenant from session, then theme/density, then toasts).

**Approach.** Per target §4.9, providers render *static identity*
(the resolved port adapters, the resolved `tenantId`); the *dynamic*
state (theme value, density value, toast queue) lives in Zustand
behind these provider hooks. `<ThemeProvider />` does not own the
theme; it owns the `<html data-theme="...">` *effect* of the theme.

The provider order matters: `PortsProvider` must come before
`TenantProvider` (which reads `SessionPort` via `usePorts()`).

**Tenancy implications.** `useTenantId()` now returns the value from
`SessionPort.getSession().tenantId`. Local: `LOCAL_TENANT`. Hosted:
JWT-derived. Hook signature unchanged.

**Acceptance:**

- `pnpm web:check` passes.
- `pnpm web:dev` boots; the existing five views still render.
- Theme toggle button in the legacy `App.tsx` topbar still works (it
  still writes its own `useState<Theme>` — that wire is replaced in
  S-06).

**QA checklist:** confirm theme toggle still flips light/dark.

**Deferred follow-ups:** S-06 deletes the inline theme `useState` and
points the toggle at `useTheme()`.

---

#### S-06: feat(web): introduce AppShell + Topbar + NavBar + ThemeToggle + ConnectionStatusPill (legacy view switcher hosted within)

| Attribute | Detail |
|---|---|
| **Phase** | 1 — Foundation |
| **Frontend area** | App chrome |
| **Target sections** | §4.10 (theme), §11 (`shared/layout/`), §13 (`AppShell`, `Topbar`, `NavBar`, `ThemeToggle`, `ConnectionStatusPill`). |

**Files touched:**

- `apps/web/src/shared/layout/AppShell.tsx` — **new** persistent chrome.
  Signature:
  ```tsx
  export function AppShell({
    currentView, setView, globalQuery, setGlobalQuery, children,
  }: {
    currentView: View; setView: (v: View) => void;
    globalQuery: string; setGlobalQuery: (q: string) => void;
    children: ReactNode;
  }): JSX.Element;
  ```
  Renders `<Topbar />` + `<NavBar />` + `<main>{children}</main>` +
  `<DevTools />` (dev only). The four "App-state-as-prop" arguments
  exist only in Phase 1; Phase 2 (S-09) deletes them in the same
  commit that switches `<AppShell>` to host `<Outlet />` and the
  global search becomes URL-bound.
- `apps/web/src/shared/layout/Topbar.tsx` — **new** brand mark,
  `<ThemeToggle />`, density `<Select />`, `<ConnectionStatusPill />`,
  global search `<Input value={globalQuery} onChange={(e) => setGlobalQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && globalQuery.trim()) setView("jobs"); }} />`
  — preserves the App.tsx:137-148 behavior verbatim via the props
  drilled through `<AppShell>`. Phase 2 (S-09) replaces the prop
  wiring with `navigate({ to: "/jobs", search: { q: value } })` per
  target §6.6.
- `apps/web/src/shared/layout/NavBar.tsx` — **new** five nav buttons.
  Signature: `<NavBar currentView={currentView} onViewChange={setView} />`.
  Renders five `<button onClick={() => onViewChange(item)} className={currentView === item ? "on" : ""}>{label}</button>`
  entries. The five `(View, label)` pairs are: `("dashboard", "Dashboard")`,
  `("jobs", "Jobs")`, `("artifacts", "Artifacts")`, `("profile", "Profile")`,
  `("config", "Settings")` — note `View = "config"` (legacy enum at
  App.tsx:24) maps to display label `"Settings"` per target §11
  naming. The `View` enum stays unchanged in Phase 1; Phase 2 (S-09)
  deletes the enum entirely when routes own naming, at which point
  the route path `/settings` makes the rename concrete in URL space
  without a separate enum migration.
- `apps/web/src/shared/layout/ThemeToggle.tsx` — **new** uses
  `useTheme()` from S-03; calls `setTheme(theme === "dark" ? "light" : "dark")`.
- `apps/web/src/shared/layout/ConnectionStatusPill.tsx` — **new** reads
  the (stubbed) `EventStreamPort.status`; renders "stub mode" today;
  goes live in Phase 5.
- `apps/web/src/App.tsx` — **refactor** at this point the file
  contains: top-level `useState<View>("dashboard")` (line 61),
  density/`globalQuery`/selectedJobKey/`selectedActivity`/`selectedApplyRun`
  `useState`s (preserved through Phase 1), `refreshSummary` callback,
  view-switcher body, and the three drawer mounts. The refactor:
  1. **Delete** the inline theme `useState<Theme>` (App.tsx:63-66).
  2. **Delete** the `useEffect` that writes to `localStorage` and
     `document.documentElement.dataset.theme` (App.tsx:95-98) — the
     new `<ThemeProvider>` from S-05 owns this effect.
  3. **Delete** the entire legacy `<header className="topbar">` block
     (App.tsx:124-171) — every child element (brand button,
     `<nav>`, global search `<input>`, density `<select>`, reload
     button, theme button, connection pill) is now owned by the new
     `<Topbar>` / `<NavBar>` / `<ThemeToggle>` /
     `<ConnectionStatusPill>` rendered inside `<AppShell>`.
  4. **Wrap** the surviving view-switcher body (App.tsx:172-209) in
     `<AppShell currentView={view} setView={setView} globalQuery={globalQuery} setGlobalQuery={setGlobalQuery}>...</AppShell>`.
     The `<Kpis>` / banner / `<main>` / drawer mounts move inside
     `<AppShell>`'s `{children}`. The "sync local data" reload button
     (App.tsx:154-161) is dropped — `useDashboardSummaryQuery` from
     Phase 3 (S-13) handles refetch declaratively; in Phase 1 the
     existing `refreshSummary()` is still called on mount but the
     manual reload button surface is removed (it survives nowhere
     post-target per §11; this Phase 1 deletion just brings forward
     the inevitable). Document this in the QA checklist as an
     intentional UX delta.
  5. The view switcher itself (App.tsx:178-194) **stays** until
     Phase 2 (S-09).
- `apps/web/index.html` — **refactor** preload `data-theme` from
  `localStorage` synchronously to avoid the FOUC on cold load
  (`<script>document.documentElement.dataset.theme = JSON.parse(localStorage.getItem("jh:theme") ?? '"light"')</script>`).

**Approach.** The `<AppShell />` becomes the persistent chrome around
*every* future route. In this phase it renders `{children}` where
`children` is the legacy `App.tsx` view switcher body. Phase 2 replaces
`{children}` with `<Outlet />` from TanStack Router; the same
`<AppShell />` file stays.

The inline theme ceremony in `App.tsx` is deleted in this same step
because the new `<ThemeToggle />` component now owns it via
`useTheme()` → `useUiPreferencesStore`. The legacy `localStorage` key
`jobhunter-theme` is renamed to `jh:theme` (the Zustand `persist`
key); a one-shot read of the legacy key on first boot is **not**
included — the user has one device; if they refresh once after the
deploy the new theme stays.

**Tenancy implications.** None; the AppShell does not display tenant
information today. The hosted multi-tenant switcher slot in the
Topbar is named-not-built per target §9.4.

**Acceptance:**

- `pnpm web:check`, `pnpm web:build`, `pnpm web:dev` all pass.
- The five existing views render inside `<AppShell />`.
- The theme toggle in `<Topbar />` flips light/dark; the choice
  survives refresh; refreshing does not flash the wrong theme.
- The connection-status pill renders "stub mode".
- The inline `useState<Theme>` in `App.tsx` is gone (CI grep guard:
  `! grep -nE 'useState<Theme>' apps/web/src/App.tsx`).
- The legacy `<header className="topbar">` block (App.tsx:124-171) is
  gone; its functions are served by the `<Topbar>` / `<NavBar>` /
  `<ThemeToggle>` / `<ConnectionStatusPill>` (CI grep guard:
  `! grep -nE 'header className="topbar"' apps/web/src`).
- Global search input value updates `globalQuery` and `Enter`
  switches to the jobs view (preserved behavior, now via prop drill;
  Phase 2 S-09 makes it URL-bound).
- Density `<Select />` value persists across refresh and writes
  `data-density` on the AppShell root.

**QA checklist:**

- [ ] Dashboard renders.
- [ ] Jobs view renders, sort still works, bulk select still works.
- [ ] Artifacts view renders, open-in-OS still works.
- [ ] Settings view renders, settings save still works.
- [ ] Profile view renders, PDF preview still loads, resume import
  wizard still works.
- [ ] Theme toggle persists across refresh; no flash.
- [ ] Density `<Select />` value persists across refresh.
- [ ] Global search: typing a query + Enter switches to the jobs
  view with `globalQuery` populated.
- [ ] Intentional UX delta: the legacy "sync local data" reload
  button (App.tsx:154-161) is gone. The dashboard still loads on
  mount via `refreshSummary()`; explicit reload returns in Phase 3
  (S-13) via TanStack Query refetch + browser refresh.

**Deferred follow-ups:** Phase 2 replaces the inline view switcher in
`App.tsx` with `<Outlet />`, deletes the file's view-switcher body
entirely, deletes the prop-drill arguments to `<AppShell>`, and
makes the global search URL-bound via `navigate({ search })`.

**Phase 1 Done When (cumulative across step PRs):**

- All six step PRs landed in stack order: S-01, S-02, S-03, S-04, S-05, S-06.
- `pnpm web:check && pnpm web:build && pnpm test` pass on the
  branch after S-06 lands.
- Manual matrix: every flow in `docs/local-reliability-qa.md`.
- The legacy `App.tsx` view-switcher body remains (~2,400 LOC) — this
  is intentional; Phase 2 owns its deletion.

---

### Phase 2: Router — File-Based TanStack Router & Per-Route View Split

**Motivation.** The current `App.tsx` has a `useState<View>` switcher
(App.tsx:61, 178-194) and `window.dispatchEvent` cross-component
coordination (App.tsx:102, 410-430). Refresh always lands on the
dashboard; deep links to a job or artifact are impossible; cross-view
filter prefill happens through an untyped global event. The target's
§2.1, §4.3, and §6.6 are unambiguous: URL state owns filters,
sort, pagination, drawer-open; cross-component coordination goes
through the URL or the query cache, never `window.dispatchEvent`.

**Scope.** Install TanStack Router (file-based via the Vite plugin),
configure `tsr.config` and `vite.config.ts`, scaffold the route tree
under `routes/`, split the legacy `App.tsx` view bodies into
`views/<name>/<View>.tsx` files, delete the legacy `App.tsx`
monolith, delete `useState<View>`, delete every
`window.dispatchEvent`/`addEventListener` cross-component coordination
site, and bind URL state (Zod-typed) to filters / sort / pagination /
drawer-open.

**Sequenced steps.**

---

#### S-07: chore(web): install TanStack Router + Vite plugin + configure route generation

| Attribute | Detail |
|---|---|
| **Phase** | 2 — Router |
| **Frontend area** | Routing infrastructure |
| **Target sections** | §2.5 (route-level Zod), §4.3 (file-based decision), §11 (`routes/`). |

**Files touched:**

- `apps/web/package.json` — **refactor** add `@tanstack/react-router`,
  `@tanstack/react-router-devtools`, `@tanstack/router-plugin`. (`zod`
  already pinned in S-01.)
- `apps/web/vite.config.ts` — **refactor** add `tanstackRouter({ target: "react", autoCodeSplitting: true })` plugin from `@tanstack/router-plugin/vite`.
- `apps/web/tsr.config.json` — **new** `routesDirectory: "./src/routes"`,
  `generatedRouteTree: "./src/routeTree.gen.ts"`, `routeFileIgnorePrefix: "-"`,
  `quoteStyle: "double"`, `semicolons: true`.
- `apps/web/.gitignore` — **refactor** add `src/routeTree.gen.ts`.
- `apps/web/src/main.tsx` — **refactor** import the not-yet-populated
  generated route tree (the file is auto-generated on `vite dev`); the
  `<RouterProvider router={router} />` mount happens in S-08 once a
  `__root.tsx` exists.
- `apps/web/src/shared/lib/zod-search.ts` — **new** small helpers for
  the per-route Zod search-param schemas (target §2.5 / §4.3): a
  `defineSearch<T extends ZodObject>(schema: T)` helper that returns
  `{ schema, validateSearch: schema.parse }`.

**Approach.** TanStack Router's Vite plugin auto-generates the route
tree from the file structure; `autoCodeSplitting: true` produces
per-route chunks for free per target §4.3 question 12. The plugin
needs a route file to generate from; this step ships the plumbing,
S-08 ships the routes, S-09 wires `<RouterProvider />` into
`<App />`.

The `tsr.config.json` `routeFileIgnorePrefix: "-"` lets us scaffold
helper files inside `routes/` (e.g., `routes/-jobs.search.ts` for the
shared search-param schema) without them becoming routes — useful for
co-locating route-level helpers without leaking them into the URL
space.

**Tenancy implications.** The hosted `/t/$tenantId/*` route prefix
(target §9.4) is named-not-built; route shapes here have no tenant
segment. When the hosted prefix lands, the existing routes nest
under a `_t.tsx` layout route in one PR.

**Acceptance:**

- `pnpm web:dev` starts; the plugin reports "no routes found" warning
  (expected — S-08 adds them).
- `pnpm web:check` passes.

**QA checklist:** none — no UI yet.

**Deferred follow-ups:** S-08 adds `routes/__root.tsx` and the route
tree.

---

#### S-08: feat(web): scaffold route tree (__root + dashboard + jobs + artifacts + profile + settings + 404)

| Attribute | Detail |
|---|---|
| **Phase** | 2 — Router |
| **Frontend area** | Route tree |
| **Target sections** | §3.4 / §4.4.4 (Profile + wizard nesting), §4.3 (final route tree), §11 (`routes/`). |

**Files touched (every file is **new**):**

- `apps/web/src/routes/__root.tsx` — provider stack + `<AppShell><Outlet /></AppShell>` + `<Devtools />` (dev only). Children include the shadcn
  `<Toaster />` (provider added in S-05) and the `<RouterDevtools />`.
- `apps/web/src/routes/index.tsx` — `/` redirects to `/dashboard` via
  `beforeLoad: ({ navigate }) => navigate({ to: "/dashboard" })`.
- `apps/web/src/routes/dashboard.tsx` — mounts `<DashboardView />` (from
  S-09).
- `apps/web/src/routes/jobs.tsx` — layout route. Owns the jobs
  search-param schema (`stage`, `state`, `deleted`, `q`, `sort`, `dir`,
  `page`, `pageSize`) per target §4.3. Renders `<JobsView />` + `<Outlet />`
  (drawer slot).
- `apps/web/src/routes/jobs.index.tsx` — empty index route (table-only
  state).
- `apps/web/src/routes/jobs.$jobId.tsx` — drawer route; mounts
  `<JobDetailDrawer jobId={params.jobId} />` (from S-09). Closing
  navigates back to `/jobs?<preserved-search>`.
- `apps/web/src/routes/jobs.$jobId.run.$runId.tsx` — apply-run timeline
  drawer; mounts `<ApplyRunTimeline runId={params.runId} />` per
  target §4.4.7.
- `apps/web/src/routes/artifacts.tsx` — layout route. Owns the
  artifacts search-param schema (`status`, `q`, `sort`, `dir`, `page`,
  `pageSize`).
- `apps/web/src/routes/artifacts.index.tsx`.
- `apps/web/src/routes/artifacts.$artifactId.tsx`.
- `apps/web/src/routes/profile.tsx` — layout.
- `apps/web/src/routes/profile.index.tsx` — editor.
- `apps/web/src/routes/profile.import.tsx` — wizard layout (renders
  `<ResumeImportWizard />` chrome + `<Outlet />`).
- `apps/web/src/routes/profile.import.upload.tsx`.
- `apps/web/src/routes/profile.import.preview.tsx`.
- `apps/web/src/routes/profile.import.confirm.tsx`.
- `apps/web/src/routes/settings.tsx` — layout.
- `apps/web/src/routes/settings.index.tsx`.
- `apps/web/src/routes/settings.credentials.tsx`.
- `apps/web/src/routes/__404.tsx` — not-found component.

**Approach.** Each route file is a thin
`createFileRoute("/jobs")({ component: JobsRouteComponent, validateSearch: jobsSearchSchema.parse })`
that mounts the corresponding view from `views/`. Route files own
search-param schemas; views own the rendering. Per target §4.3 the
drawer is a route child (`jobs.$jobId.tsx`), not a `useState` toggle —
navigating to `/jobs/$jobId?stage=apply` opens the drawer with the
table preserved underneath. Closing navigates back to
`/jobs?<preserved-search>`.

The wizard at `profile.import.{upload,preview,confirm}.tsx` is a
nested route per target §4.4.4 (resolves question 8) — each step is
its own URL; refresh resumes; browser back/forward works; the draft
state lives in `profileImportStore` (from S-03) so a refresh does not
lose the upload.

The view files referenced here (`<DashboardView />`, `<JobsView />`,
etc.) are populated in S-09; this step ships the route shells with
placeholder bodies that import the view files. S-08 + S-09 land in
the same phase (Phase 2 squash) so the intermediate state never
ships.

**Tenancy implications.** None at this layer. The `/t/$tenantId/*`
prefix is named-not-built (§9.4).

**Acceptance:**

- `pnpm web:dev` regenerates `routeTree.gen.ts`; the plugin reports
  every route discovered.
- `pnpm web:check` passes.
- `<RouterProvider />` is mounted in S-09 (final wire-up); until
  then the routes exist in the generated tree but the app still
  renders the legacy `App.tsx` body.

**QA checklist:** none — visible behavior unchanged until S-09.

**Deferred follow-ups:** S-09.

---

#### S-09: feat(web): split App.tsx into per-view files; mount RouterProvider; delete useState<View>; delete window.dispatchEvent coordination

| Attribute | Detail |
|---|---|
| **Phase** | 2 — Router |
| **Frontend area** | View extraction |
| **Target sections** | §2.1 (URL state rules), §3.10 (views are not contexts), §4.5 (view composition), §6.6 (no direct DOM access), §11 (`views/`). |

**Files touched (every `views/` file is **new**, populated by extracting
from the legacy `App.tsx`; `apps/web/src/App.tsx` is **rewritten** to
< 50 LOC; the legacy 2,527-line body is **deleted** end-to-end):**

- `apps/web/src/App.tsx` — **refactor** to:
  ```tsx
  import { RouterProvider } from "@tanstack/react-router";
  import { router } from "./router";
  export function App() { return <RouterProvider router={router} />; }
  ```
  All 2,527 LOC of view bodies are gone. Recovery is via git history
  (`git log --all --full-history -- apps/web/src/App.tsx` then
  `git show <sha>:apps/web/src/App.tsx`); no special anchor needed.
- `apps/web/src/router.ts` — **new** `createRouter({ routeTree, defaultPreload: "intent", context: { queryClient: undefined! /* set in Phase 3 */, tenantId: undefined! /* same */ } })` — context placeholders are filled in Phase 3.
- `apps/web/src/views/dashboard/DashboardView.tsx` — **new** extracted
  from `App.tsx:255-349` (Dashboard) + `App.tsx:213-253` (Kpis) — see
  S-15 for the URL-bound prefill replacing the legacy
  `window.dispatchEvent("jobhunter:set-jobs-filter", "failed")` (now
  `<Link to="/jobs" search={{ state: "failed" }} />` from each KPI
  card per target §6.6).
- `apps/web/src/views/dashboard/KpiGrid.tsx` — **new** extracted from
  `Kpis` / `KpiSkeleton`.
- `apps/web/src/views/dashboard/Funnel.tsx` — **new** extracted from
  the funnel JSX in `Dashboard`.
- `apps/web/src/views/dashboard/ActivityFeed.tsx` — **new** extracted
  from the activity-feed JSX.
- `apps/web/src/views/dashboard/ApplyRunsCard.tsx` — **new**.
- `apps/web/src/views/dashboard/ApplyRunTimeline.tsx` — **new** extracted
  from the legacy `ApplyRunDrawer`'s timeline subsection
  (App.tsx:2033-2089). **This file is the canonical home for
  `<ApplyRunTimeline>` between S-09 and S-17.** Both
  `routes/jobs.$jobId.run.$runId.tsx` (S-08) and
  `views/dashboard/ApplyRunDrawer.tsx` (this step) import from
  `views/dashboard/ApplyRunTimeline.tsx`. S-17 (Phase 4) **moves**
  this file from `views/dashboard/` to its target home at
  `apps/web/src/contexts/apply/components/ApplyRunTimeline.tsx`
  (target §3.7) and updates both importers in the same commit.
  The interim location is necessary because S-17 (Phase 4) is
  where the cross-context apply components land; Phase 2 cannot
  reach into `contexts/apply/` without preempting Phase 4 scope.
- `apps/web/src/views/dashboard/ApplyRunDrawer.tsx` — **new** extracted
  from the legacy `ApplyRunDrawer` (App.tsx:2033-2089) chrome.
  Mounted by the new route `routes/runs.$runId.tsx` (added in this
  step; list-of-active-apply-runs lives on the dashboard, so
  drawer-route parents under the root rather than under
  `/jobs/$jobId`). Imports `<ApplyRunTimeline>` from the previous
  bullet's interim location.
- `apps/web/src/views/dashboard/ActivityDetailDrawer.tsx` — **new**
  extracted from the legacy `ActivityDetailDrawer` (App.tsx:2090-2135).
  Mounted by the new route `routes/activity.$eventId.tsx` (added in
  this step). Per the legacy `openActivity` logic (App.tsx:109-117),
  activities WITH a `jobKey` redirect to `/jobs/$jobKey` (the
  redirect is now via TanStack Router `redirect()` in the route's
  `beforeLoad` rather than the imperative `openJob` call); activities
  WITHOUT a `jobKey` open this drawer route. The `eventId` route
  param is the event's row id (from `DashboardSummary["activity"]`);
  the drawer reads from a small `useActivityEventQuery(eventId)`
  hook added under `contexts/operations/hooks/` (this hook is added
  in S-13 and used here via Phase 3's wiring; in Phase 2 the drawer
  receives the `activity` row as route loader data passed from the
  dashboard's already-loaded `DashboardSummary`).
- `apps/web/src/routes/runs.$runId.tsx` — **new** route file added in
  this step (S-08 covered the route shells but not this one because
  it surfaced from the legacy `ApplyRunDrawer` audit).
- `apps/web/src/routes/activity.$eventId.tsx` — **new** route file
  same.
- `apps/web/src/views/jobs/JobsView.tsx` — **new** extracted from
  `App.tsx:351-655` (`JobsView`). The hand-rolled `useState`/`useEffect`/
  `useRef` data fetching stays in this step; it is replaced in Phase 3.
  The `window.addEventListener("jobhunter:set-jobs-filter", ...)`
  block (App.tsx:409-430) is **deleted in this step** — its function
  (prefilling filters from KPI clicks) now happens via URL search-params
  (S-09 changes the `<Kpis>` `onSelect` callback to call
  `navigate({ to: "/jobs", search: { state: "failed" } })` instead of
  dispatching the custom event).
- `apps/web/src/views/jobs/JobsTable.tsx` — **new** initially the
  hand-rolled table from `App.tsx:599-651`; replaced by TanStack Table
  in Phase 4.
- `apps/web/src/views/jobs/JobFilterBar.tsx` — **new** extracted from
  `App.tsx:532-570` (toolbar JSX). Reads / writes URL search via
  `useSearch({ from: "/jobs" })` and `useNavigate({ from: "/jobs" })`.
- `apps/web/src/views/jobs/JobBulkActions.tsx` — **new** extracted from
  `App.tsx:571-598` (bulk-bar JSX). The bulk-selection set is the one
  documented exception in target §5.1: ephemeral component `useState`.
- `apps/web/src/views/jobs/JobDetailDrawer.tsx` — **new** extracted from
  the legacy `JobDrawer` component (the section after JobsView in App.tsx).
  Mounted by `routes/jobs.$jobId.tsx`; closes via
  `navigate({ to: "/jobs", search: prevSearch })` per target §4.3.
- `apps/web/src/views/jobs/JobOverview.tsx` — **new** the overview
  panel from the legacy drawer.
- `apps/web/src/views/artifacts/ArtifactsView.tsx` — **new** extracted
  from `App.tsx:657-809`.
- `apps/web/src/views/artifacts/ArtifactsTable.tsx` — **new**.
- `apps/web/src/views/artifacts/ArtifactFilterBar.tsx` — **new**.
- `apps/web/src/views/artifacts/ArtifactDetailPanel.tsx` — **new** mounted
  by `routes/artifacts.$artifactId.tsx`.
- `apps/web/src/views/artifacts/ArtifactGroup.tsx` — **new** the
  per-job grouping helper used by `JobDetailDrawer` per target §3.10
  (the grouping helper is view-level, not context-level).
- `apps/web/src/contexts/profile/components/ProfileEditor.tsx` — **new**
  extracted from `App.tsx:1049-end` (`ProfileView`). The profile editor
  belongs to the `profile` context (target §3.4) — not a view — because
  it is the *one* surface owned by Profile.
- `apps/web/src/contexts/profile/components/ResumePreviewIframe.tsx` —
  **new** extracted PDF preview iframe; the cache-key derivation logic
  lands in Phase 3 (S-13's `useProfilePdfPreviewUrl`).
- `apps/web/src/contexts/profile/components/ResumeImportWizard.tsx` —
  **new** wizard chrome (step indicator, "back"/"next" `<Link>`s).
- `apps/web/src/contexts/profile/components/SettingsPanel.tsx` — **new**
  extracted from `App.tsx:811-1037` (`ConfigView`).
- `apps/web/src/contexts/profile/components/CredentialsPanel.tsx` —
  **new** extracted credential-management JSX from the same `ConfigView`
  region.
- `apps/web/src/shared/layout/NavBar.tsx` — **refactor** replace the
  `onClick={() => setView("jobs")}` callback prop with TanStack Router
  `<Link to="/jobs" />` etc.
- `apps/web/src/shared/layout/AppShell.tsx` — **refactor** replace
  `{children}` with `<Outlet />` from `@tanstack/react-router` (the
  shell is now mounted by `routes/__root.tsx`).
- `apps/web/src/shared/layout/Topbar.tsx` — **refactor** the global
  search input writes to a URL search param when `Enter` is pressed
  (`navigate({ to: "/jobs", search: { q: value } })`); replaces the
  `setView("jobs")` + `setGlobalQuery(...)` `useState` ceremony at
  `App.tsx:142-148`.
- `apps/web/index.html` — **refactor** preload script unchanged from
  S-06.

**Helper Migration Map.** The legacy `App.tsx` contains ~30 helper
functions / utility components / one big sub-component beyond the
five view bodies. Each gets an explicit destination in this step so
the `< 50 LOC` acceptance is met without scattering or duplication:

| Source (App.tsx) | Symbol | Destination |
|---|---|---|
| 1280-1776 | `StructuredProfileEditor` (~497 LOC) | `apps/web/src/contexts/profile/components/StructuredProfileEditor.tsx` |
| 1039 | `credentialLabel(key)` | co-located in `apps/web/src/contexts/profile/components/CredentialsPanel.tsx` |
| 1777 | `parseJsonRecord(text)` | `apps/web/src/contexts/profile/lib/json-record.ts` |
| 1786 | `cloneJsonRecord(value)` | same |
| 1790 | `isJsonRecord(value)` | same |
| 1794 | `getPathValue(source, path)` | same |
| 1804 | `setPathValue(source, path, value)` | same |
| 1822 | `textAt(source, path)` | same |
| 1826 | `textFrom(...)` | same |
| 1833 | `textArrayAt(...)` | same |
| 1837 | `asTextArray(...)` | same |
| 1841 | `recordAt(...)` | same |
| 1846 | `recordArrayAt(...)` | same |
| 1851 | `numberOrEmpty(...)` | same |
| 1855 | `lines(...)` | same |
| 1862 | `defaultRepeatItem(...)` | same |
| 2033 | `ApplyRunDrawer` | `apps/web/src/views/dashboard/ApplyRunDrawer.tsx` (per the explicit "Files touched" entry above) |
| 2090 | `ActivityDetailDrawer` | `apps/web/src/views/dashboard/ActivityDetailDrawer.tsx` (same) |
| 2136 | `CardHeader` | `apps/web/src/shared/ui/card-header.tsx` (small custom; shadcn `<Card>` covers the layout but the title+meta combination is JobHunter-specific) |
| 2145 | `SegmentBar` | `apps/web/src/shared/ui/segment-bar.tsx` (custom; no shadcn equivalent) |
| 2155 | `Pager` | **deleted** in S-17 (Phase 4) — TanStack Table v8 owns pagination. In S-09 / S-15 it lives temporarily at `apps/web/src/shared/ui/pager.tsx` so views can keep rendering. |
| 2179 | `Editor` | `apps/web/src/contexts/profile/components/Editor.tsx` (used only by profile editor; co-located with consumer) |
| 2232 | `Section` | `apps/web/src/shared/ui/section.tsx` |
| 2241 | `ScoreReasoning` | `apps/web/src/contexts/scoring/components/ScoreReasoning.tsx` (it renders a fit-score string parsed via `parseScoreReasoning`; contextually scoring) |
| 2277 | `JobDescription` | `apps/web/src/views/jobs/JobDescription.tsx` (job-detail-only) |
| 2291 | `SelectPairs` | **deleted** in S-17 — TanStack Table column model + ArtifactsTable replace this; in S-09 / S-15 it lives temporarily at `apps/web/src/shared/ui/select-pairs.tsx`. |
| 2311 | `DirectionSelect` | same — temporarily `apps/web/src/shared/ui/direction-select.tsx`; deleted in S-17. |
| 2320 | `PageSize` | same — temporarily `apps/web/src/shared/ui/page-size.tsx`; deleted in S-17. |
| 2332 | `StatusDot` | `apps/web/src/shared/ui/status-dot.tsx` |
| 2336 | `Empty` | `apps/web/src/shared/ui/empty.tsx` (shadcn `<Skeleton>` is for placeholder rectangles; `<Empty>` is the "nothing to show" message component — different concern) |
| 2340 | `scoreTier(score)` | `apps/web/src/contexts/scoring/lib/score-tier.ts` |
| 2350 | `stateTone(state)` | `apps/web/src/contexts/pipeline/lib/state-tone.ts` |
| 2363 | `artifactStatusTone(status)` | `apps/web/src/contexts/materials/lib/artifact-status-tone.ts` |
| 2373 | `useEscapeKey(active, onEscape)` | `apps/web/src/shared/hooks/useEscapeKey.ts` (shadcn `<Sheet>` and `<Dialog>` ship with Esc-to-close — this hook only survives where a custom panel needs it; audit during S-09 may delete the hook entirely if shadcn covers all sites) |
| 2388 | `formatDateTime(value)` | `apps/web/src/shared/lib/formatters.ts` |
| 2396 | `parseScoreReasoning(text)` | `apps/web/src/contexts/scoring/lib/parse-reasoning.ts` |
| 2424 | `descriptionBlocks(text)` | `apps/web/src/contexts/operations/selectors/jobDescriptionSelectors.ts` |
| 2455 | `formatCompanySource(company, source)` | `apps/web/src/shared/lib/formatters.ts` |
| 2462 | `groupArtifacts(artifacts)` | `apps/web/src/views/artifacts/selectors/artifactSelectors.ts` |
| 2482 | `compareArtifactVersions(a, b)` | same |
| 2486 | `artifactVersionRank(type)` | same |
| 2502 | `artifactKind(type)` | same |
| 2506 | `artifactVersionLabel(type)` | same |
| 2516 | `fileToBase64(file)` | `apps/web/src/shared/lib/file.ts` |
| 2525 | `isRecord(value)` | `apps/web/src/shared/lib/type-guards.ts` |

A "transition" subset (`Pager`, `SelectPairs`, `DirectionSelect`,
`PageSize`) lives temporarily under `shared/ui/` between S-09 and
S-17 so views render during Phase 2/3; S-17 deletes them when
TanStack Table v8 owns the equivalent surface. The CI grep guard
in S-17 (`! grep -nrE 'from "@/shared/ui/(pager|select-pairs|direction-select|page-size)"' apps/web/src`)
fails the build if any view re-imports them after the table swap.

**Approach.** This is the largest step in the plan: every view body
in the legacy `App.tsx` is extracted into a per-view file. The
**internals** of each view (manual `useState`/`useEffect`/`useRef`
fetch ceremony, sort buttons, pagination JSX, draft-vs-original form
state) are **preserved** in this step — they are deleted in Phase 3
(fetch ceremony), Phase 4 (table + form). This is a deliberate split:
extracting the views is its own substantial change; replacing their
internals is a separate substantial change. Both phases land
independently, each leaving the app working.

The two **structural** deletions in this step are non-negotiable:

1. `useState<View>("dashboard")` (App.tsx:61) and the inline
   `view === "dashboard" ? <Dashboard /> : view === "jobs" ? ...`
   ladder (App.tsx:178-194) are **deleted**. The router replaces them.
2. Every `window.dispatchEvent(new CustomEvent("jobhunter:set-jobs-filter", ...))`
   (App.tsx:102) and matching
   `window.addEventListener("jobhunter:set-jobs-filter", ...)`
   (App.tsx:410-430) site is **deleted**. The KPI click prefilling the
   jobs filter now does
   `navigate({ to: "/jobs", search: { state: "failed", page: 1 } })`
   per target §6.6. The CI grep guard
   `! grep -rE 'dispatchEvent\(new CustomEvent' apps/web/src` is
   added in S-15 (Phase 3 documentation step inside the phase) and
   enforced from Phase 2 onward.

The view files initially **import the bare `JobHunterApiClient`**
(via the singleton `api` from the legacy `App.tsx`) for their
hand-rolled fetch calls; Phase 3 replaces every `api.x()` call with a
hook from `contexts/operations/` or `contexts/<aggregate>/`.

**Tenancy implications.** None at the view level — every URL is
tenant-implicit until §9.4 ships the prefix.

**Acceptance:**

- `pnpm web:check`, `pnpm web:build`, `pnpm web:dev` pass.
- `apps/web/src/App.tsx` is < 50 LOC.
- The legacy 2,527-line body is gone (CI grep guard:
  `[ "$(wc -l < apps/web/src/App.tsx)" -lt 60 ]`).
- The `useState<View>` line is gone (CI grep guard:
  `! grep -nE 'useState<View>' apps/web/src/`).
- The `window.dispatchEvent`/`addEventListener` for
  `jobhunter:set-jobs-filter` is gone everywhere (CI grep guard
  `! grep -rE 'jobhunter:set-jobs-filter' apps/web/src`).
- Refresh on `/jobs?state=failed` stays on the filtered view.
- Refresh on `/jobs/$jobId` reopens the drawer with the table
  preserved underneath.
- Refresh on `/profile/import/preview` resumes the wizard at preview
  step.

**QA checklist:**

- [ ] Dashboard renders; KPI clicks navigate to `/jobs?state=...`;
  refresh keeps filter.
- [ ] Jobs view renders; each filter (`stage`, `state`, `deleted`,
  `sort`, `dir`, `page`, `pageSize`, `q`) reflected in URL; refresh
  preserves it; copy URL → paste in new tab → same filtered view.
- [ ] Click a job → drawer opens; URL becomes `/jobs/$jobId?...`;
  refresh keeps drawer + filter; close drawer → URL becomes
  `/jobs?...`.
- [ ] Artifacts view renders; URL-bound filters / sort / pagination
  work; click an artifact row → `/artifacts/$artifactId` panel.
- [ ] Profile editor renders; PDF preview shows; resume import
  wizard moves between `/profile/import/{upload,preview,confirm}`;
  browser back/forward works; refresh on `/profile/import/preview`
  resumes there with the upload still in store.
- [ ] Settings view renders; credentials panel renders.
- [ ] Theme toggle / density `<Select />` still work.
- [ ] No console errors about `jobhunter:set-jobs-filter`.
- [ ] Activity row WITH `jobKey` → `/jobs/$jobKey` (existing
  behavior, now URL-bound).
- [ ] Activity row WITHOUT `jobKey` → `/activity/$eventId` opens
  `<ActivityDetailDrawer>` (preserved behavior; new route).
- [ ] Apply-run row on the dashboard → `/runs/$runId` opens
  `<ApplyRunDrawer>` (preserved behavior; new route). Its inner
  timeline is the same `<ApplyRunTimeline>` mounted by
  `routes/jobs.$jobId.run.$runId.tsx`.

**Deferred follow-ups:**

- Phase 3: the per-view hand-rolled fetch ceremony is replaced by
  TanStack Query hooks; the singleton `api` import is deleted;
  `useState<DataShape>` + `useEffect` + `useRef(0)` blocks are gone
  everywhere.
- Phase 4: the per-view hand-rolled table / form code is replaced.

**Phase 2 Done When (cumulative across step PRs):**

- All three step PRs landed in stack order: S-07, S-08, S-09.
- `pnpm web:check && pnpm web:build && pnpm test` pass on the
  branch after S-09 lands.
- Manual matrix as in the QA checklist above.
- Legacy `App.tsx` 2,527 LOC monolith is deleted.

---

### Phase 3: Query — Per-Context Hooks, Keys, Ports, EventStream Scaffolding

**Motivation.** Every view file post-Phase-2 contains a hand-rolled
`useState<DataShape>` + `useEffect` + `useRef(0)` (`requestSeq`)
plumbing block — the textbook case TanStack Query was built to delete
(target §2.1 rules, §5.1 layer table). Mutations call the API and
then manually re-call `load()` plus sibling loaders
(`await Promise.all([load(), onJobsChanged()])` at App.tsx:518). The
target's §4.1 / §4.2 / §4.4 / §5 / §6 / §7.4 / §8 collectively define
the replacement: per-context query-key factories, projection-typed
read hooks owned by Operations, mutation hooks owned by aggregate
contexts, an `ApiClientPort` wrapping `@jobhunter/api-client`, an
`EventStreamPort` (stubbed today, real in Phase 5), and the
invalidation router scaffold.

**Scope.** Install TanStack Query v5; mount `QueryClientProvider`;
define and bind the `ApiClientPort`; populate every context folder
with its query-key factory (Operations re-exports them all); ship the
Operations read hooks and the per-aggregate mutation hooks; ship the
ACL re-export of projection types; rewrite every view file to use
the hooks (deleting all hand-rolled fetch plumbing); URL-bind every
filter / sort / pagination input to the `useSearch()` shape; scaffold
the `<EventStreamProvider>` and the empty invalidation-router map
(populated in Phase 5).

**Sequenced steps.**

---

#### S-10: chore(web): install TanStack Query v5; mount QueryClientProvider; configure defaults + global error toast

| Attribute | Detail |
|---|---|
| **Phase** | 3 — Query |
| **Frontend area** | Query infrastructure |
| **Target sections** | §4.11 (error handling), §5.4 (stale time / GC), §6.2 (PortsProvider compose). |

**Files touched:**

- `apps/web/package.json` — **refactor** add `@tanstack/react-query`
  and `@tanstack/react-query-devtools`.
- `apps/web/src/shared/providers/QueryClientProvider.tsx` — **new**
  configures `QueryClient` with the target §5.4 defaults
  (`staleTime: 30_000`, `gcTime: 5 * 60_000`, `refetchOnWindowFocus: true`,
  `refetchOnReconnect: true`, queries `retry: 1`, mutations
  `retry: false`); `QueryCache.onError` calls
  `useToastStore.getState().toast({ variant: "error", message: ... })`
  unless the failing query / mutation set `meta.suppressGlobalErrorToast`.
- `apps/web/src/routes/__root.tsx` — **refactor** wrap `<AppShell>` in
  `<QueryClientProvider>`; mount `<ReactQueryDevtools />` in dev only;
  pass `queryClient` into `router.context` for loader use per target
  §5.2.
- `apps/web/src/router.ts` — **refactor** populate the `context`
  placeholder with `{ queryClient, tenantId }`; expose
  `RouterContext` type for typed loaders.

**Approach.** Per target §5.4, defaults are intentionally conservative
(30s staleTime). The dashboard route's `useDashboardSummaryQuery`
overrides with `staleTime: 0` per target §5.4 ("dashboard summary uses
`staleTime: 0` because it is the highest-touch surface"); the
artifacts query uses `staleTime: 60_000`. These overrides land in
S-13.

The `QueryCache.onError` global handler implements the first of
target §4.11's three error-handling layers; the per-mutation `onError`
layer is per-hook in S-14; route-level error boundaries land in this
step (each route file gains an `errorComponent` that renders a
`<RouteError />` panel with a retry button calling
`queryClient.invalidateQueries({ queryKey: route.key })`).

**Tenancy implications.** `router.context.tenantId` is sourced from
`useTenantId()` at `<RouterProvider>` mount time (Phase 1's
`<TenantProvider>` already resolves it); loaders consume
`context.tenantId` directly rather than calling `useTenantId()`
inside their (non-React) function bodies.

**Acceptance:**

- `pnpm web:check`, `pnpm web:dev` pass.
- React Query Devtools panel appears in dev.
- An induced API failure (kill the API; reload `/jobs`) triggers the
  global error toast.
- Each route's `errorComponent` renders if a thrown loader error
  occurs.

**QA checklist:** confirm error toast on API kill; confirm devtools
shows the (still-empty) cache.

**Deferred follow-ups:** S-11 onward populates the cache.

---

#### S-11: feat(web): bind ApiClientPort + define operations/types.ts ACL re-exports

| Attribute | Detail |
|---|---|
| **Phase** | 3 — Query |
| **Frontend area** | API seam + ACL |
| **Target sections** | §6.3 (`ApiClientPort` detail), §6.5 (ACL re-export). |

**Files touched:**

- `apps/web/src/shared/ports/adapters/FetchApiClientAdapter.ts` —
  **refactor** flesh out (S-04 shipped a thin shell). Wraps the
  existing `JobHunterApiClient` from `@jobhunter/api-client`; the
  per-method signature mirrors the wrapped class.
- `apps/web/src/main.tsx` — **refactor** instantiate the adapter via
  `new FetchApiClientAdapter(import.meta.env.VITE_JOBHUNTER_API_BASE_URL ?? "")`
  and pass it through `<PortsProvider ports={...} />` per target §6.2.
- `apps/web/src/contexts/operations/types.ts` — **new** ACL
  re-exports of every projection type from `@jobhunter/contracts` /
  `@jobhunter/domain-types`, plus the narrowed string-union types
  (`Stage`, `StageState["kind"]`) the per-context components consume.
  Per target §6.5, this is the single point where a backend
  projection shape change surfaces as a frontend compile error.
- `apps/web/src/contexts/operations/index.ts` — **new** barrel
  exporting the public surface of `operations/` (queryKeys, hooks,
  invalidation router, types). Per target §11 principle 8 ("no barrel
  files re-exporting half the codebase"), this exports only the
  public surface.

**Approach.** The `FetchApiClientAdapter` is the local-mode
`ApiClientPort` adapter. Hosted-mode adds a JWT interceptor and
`X-Tenant-Id` header injection per target §6.3; that adapter wraps
the same underlying class and is named-not-built.

The ACL re-export at `contexts/operations/types.ts` is intentionally
thin — mostly re-exports today — but it exists as the single import
site for projection types in feature code. Direct
`from "@jobhunter/contracts"` imports for projection types in
`contexts/` and `views/` are forbidden by an ESLint
`no-restricted-imports` rule shipped in S-15.

**Tenancy implications.** The adapter accepts `TenantId` per call
site; in local mode the value is ignored (the API has no tenant
header today).

**Acceptance:**

- `pnpm web:check` passes.
- `usePorts().api` returns the adapter; calling
  `usePorts().api.dashboardSummary()` returns the same shape as the
  legacy `api.dashboardSummary()`.

**QA checklist:** none — no UI yet.

**Deferred follow-ups:** S-13 builds Operations hooks on top of this
adapter.

---

#### S-12: feat(web): per-context query-key factories + queryKeys registry

| Attribute | Detail |
|---|---|
| **Phase** | 3 — Query |
| **Frontend area** | Query keys |
| **Target sections** | §4.1 (factory pattern + tenant-first), §10.2 (parity test target — Phase 6). |

**Files touched (every file is **new**):**

- `apps/web/src/contexts/operations/queryKeys.ts` — re-exports each
  context's factory.
- `apps/web/src/contexts/operations/jobsKeys.ts` — `jobsKeys.all(tid)`,
  `.lists(tid)`, `.list(tid, filters)`, `.details(tid)`,
  `.detail(tid, jobId)` per target §4.1.
- `apps/web/src/contexts/operations/dashboardKeys.ts` —
  `dashboardKeys.all(tid)`, `.summary(tid)`.
- `apps/web/src/contexts/operations/artifactsKeys.ts` —
  `artifactsKeys.all(tid)`, `.lists(tid)`, `.list(tid, filters)`,
  `.details(tid)`, `.detail(tid, artifactId)`.
- `apps/web/src/contexts/operations/applyRunsKeys.ts` —
  `applyRunsKeys.all(tid)`, `.lists(tid)`, `.list(tid, filters)`,
  `.details(tid)`, `.detail(tid, runId)`.
- `apps/web/src/contexts/operations/healthKeys.ts` — `healthKeys.all(tid)`,
  `.live(tid)` (for the connection-pill `useHealthQuery`).
- `apps/web/src/contexts/profile/queryKeys.ts` —
  `profileKeys.all(tid)`, `.profile(tid)`, `.settings(tid)`,
  `.credentials(tid)`.

**Approach.** Per target §4.1 (resolutions to questions 4, 10): every
key starts with `["tenant", tenantId, ...]`; every factory returns
`as const` tuples for type-safe hierarchical invalidation. The
registry at `operations/queryKeys.ts` re-exports each factory so the
invalidation router (S-16) imports from one place; nothing else
imports cross-context query-key factories.

**Tenancy implications.** Resolved by construction — every key is
tenant-scoped from S-12 onward.

**Acceptance:**

- `pnpm web:check` passes.
- The factories produce keys of the documented shape (tested in
  Phase 6 unit tests).

**QA checklist:** none — no UI yet.

**Deferred follow-ups:** Phase 6 unit tests assert the produced
shapes; Phase 6 ships the parity test that ensures every projection
has a hook that uses the corresponding factory.

---

#### S-13: feat(web): Operations read hooks (dashboard, jobs, artifacts, applyRuns, health)

| Attribute | Detail |
|---|---|
| **Phase** | 3 — Query |
| **Frontend area** | Read-side hooks |
| **Target sections** | §3.9 (Operations responsibilities), §4.4.1 (per-context tactical spec), §5.2 (URL ↔ cache binding). |

**Files touched (every file is **new** under
`apps/web/src/contexts/operations/hooks/`):**

- `useDashboardSummaryQuery.ts` — `useQuery({ queryKey: dashboardKeys.summary(tenantId), queryFn: () => api.dashboardSummary(), staleTime: 0, refetchOnMount: "always" })` per target §5.4.
- `useJobsListQuery.ts` — accepts the route's `jobsSearchSchema`
  -typed input.
- `useJobDetailQuery.ts`.
- `useArtifactsListQuery.ts` — `staleTime: 60_000` per target §5.4.
- `useArtifactDetailQuery.ts`.
- `useApplyRunsListQuery.ts`.
- `useApplyRunQuery.ts`.
- `useHealthQuery.ts` — `refetchInterval: 15_000` (drives the
  connection-status pill in absence of SSE; once Phase 5 SSE is live,
  the pill reads SSE status; `useHealthQuery` becomes a low-frequency
  backstop).
- `useInvalidationRouter.ts` — exposes the (Phase-5-populated) router
  to the `<EventStreamProvider />`. In Phase 3 it returns a no-op
  router with an empty handler map.
- `apps/web/src/contexts/profile/hooks/useProfileQuery.ts` — **new**.
- `apps/web/src/contexts/profile/hooks/useSettingsQuery.ts` — **new**.
- `apps/web/src/contexts/profile/hooks/useCredentialsQuery.ts` — **new**.
- `apps/web/src/contexts/profile/hooks/useProfileMutationCount.ts` —
  **new** uses TanStack Query v5's `useMutationState`:
  ```ts
  export function useProfileMutationCount(): number {
    const tid = useTenantId();
    const data = useMutationState({
      filters: {
        mutationKey: profileKeys.profile(tid),
        status: "success",
      },
      select: (m) => m.state.submittedAt,
    });
    return data.length;
  }
  ```
  Returns the number of successful profile mutations seen in the
  current session (resets on page refresh — that's fine, the iframe
  also reloads on refresh, so cache parity holds).
- `apps/web/src/contexts/profile/hooks/useProfilePdfPreviewUrl.ts` —
  **new** uses `useProfileMutationCount()` to derive a
  monotonically-increasing cache-bust token; returns
  `usePorts().api.profilePreviewPdfUrl(count)` per target §4.4.4 /
  question 7 resolution. The mutation hooks
  (`useUpdateProfileMutation`, `useImportResumeMutation`) must use
  `mutationKey: profileKeys.profile(tid)` so this counter sees them
  — that wiring is documented in S-14.

**Approach.** Each hook reads `useTenantId()`, builds the key via the
S-12 factory, calls `usePorts().api.<method>(...)`, and returns
`UseQueryResult<Projection>`. Routes that have a loader (`/jobs`,
`/artifacts`) call
`context.queryClient.ensureQueryData({ queryKey, queryFn })` per
target §5.2; the loader runs ahead of mount and populates the cache,
so the component's `useQuery` either returns the cached data (no
spinner) or, on a subsequent navigation that hit a different page
size, returns from cache instantly while a background refetch runs.

`useHealthQuery` is unique: its `refetchInterval` polls health every
15s; this is the connection-status fallback when SSE is the
authority (Phase 5). Pre-Phase-5, it is the *only* signal. **Phase 5
S-20 modifies this hook** to disable polling when SSE is `"open"`
and slow-poll (30s) when SSE is unhealthy — the SSE heartbeat is
the authoritative liveness signal post-Phase-5.

**Tenancy implications.** Every hook reads `useTenantId()`; the key
is tenant-prefixed.

**Acceptance:**

- `pnpm web:check` passes.
- The hooks are importable; views still use the legacy `api.x()`
  ceremony (replaced in S-15).

**QA checklist:** none — no UI change.

**Deferred follow-ups:** S-15 wires the views to these hooks.

---

#### S-14: feat(web): per-aggregate mutation hooks (Discovery, Profile, Materials, Apply, Pipeline) + placeholders (Scoring, Enrichment)

| Attribute | Detail |
|---|---|
| **Phase** | 3 — Query |
| **Frontend area** | Mutation hooks |
| **Target sections** | §3.2–3.8 (per-context responsibilities), §4.4 (per-context tactical spec), §5.3 (optimistic updates), §8.2–8.3 (mutation invalidation map). |

**Files touched (every file is **new** under
`apps/web/src/contexts/<aggregate>/hooks/`):**

`discovery/`:
- `useDeleteJobMutation.ts` — optimistic patch on the affected list
  pages; rolls back on error; invalidates `jobsKeys.lists(tid)`,
  `jobsKeys.detail(tid, jobId)`, `dashboardKeys.summary(tid)` on
  settle per target §8.2.
- `useDeleteJobsBulkMutation.ts`.
- `useRestoreJobMutation.ts`.
- `useRestoreJobsBulkMutation.ts`.
- `useImportJobMutation.ts` — **placeholder** that throws
  `NotImplementedError`. The hook exists per target §3.2 ("future
  `useImportJobMutation` for manually adding a job by URL"). Hidden
  behind `FeatureFlagPort.get("discovery.importJob.enabled", false)`
  so the call site can compile and the seam is in place.

`profile/`:
- `useUpdateProfileMutation.ts` — invalidates `profileKeys.profile(tid)`,
  `jobsKeys.lists(tid)`, `dashboardKeys.summary(tid)` per target §8.2.
- `useUpdateSettingsMutation.ts` — invalidates `profileKeys.settings(tid)`.
- `useUpdateCredentialMutation.ts`, `useDeleteCredentialMutation.ts` —
  invalidate `profileKeys.credentials(tid)`.
- `useImportResumeMutation.ts` — confirm step of the wizard;
  invalidates `profileKeys.profile(tid)` on settle.

`scoring/`:
- `useCorrectScoreMutation.ts` — **placeholder** per target §3.5 / §4.4.5.

`materials/`:
- `useGenerateMaterialsMutation.ts` — async (202) per target §4.4.6 /
  §8.3: optimistic "queued" patch on `jobsKeys.detail(tid, jobId)`;
  the real result arrives via SSE in Phase 5. Records `runId` in the
  cache entry per target R14.
- `useOpenArtifactMutation.ts` — calls `usePorts().openInOs.open(artifactId)`;
  no cache invalidation per target §4.4.6.

`apply/`:
- `useApplyJobMutation.ts` — async (202); optimistic cache patch
  showing the new run as "starting".
- `useDryRunApplyMutation.ts`.
- `useCancelApplyMutation.ts` — synchronous; invalidates
  `applyRunsKeys.detail(tid, runId)`, `applyRunsKeys.lists(tid)`,
  `jobsKeys.detail(tid, jobId)`.

`pipeline/`:
- `useRetryStageMutation.ts` — sync if `runAfter: false`, async if
  `runAfter: true`; optimistic patch of `JobDetailProjection.stages`
  per target §4.4.8.
- `useCancelStageMutation.ts`.
- `useMarkAppliedMutation.ts` (`MarkAppliedUseCase` per backend §5.7).
- `useMarkSkippedMutation.ts` (`SkipJobUseCase` per backend §5.7).

`enrichment/`:
- `useEnrichmentRetryMutation.ts` — **placeholder** per target §3.3 /
  §4.4.3.

**Plus**:
- `apps/web/src/shared/lib/createOptimisticMutation.ts` — **new** the
  pure-function helper that encodes the snapshot → patch → rollback →
  invalidate pattern per target R2 ("the standard pattern is encoded
  in a small helper"). Each sync mutation hook supplies only the
  patcher and the affected key set, not the full ceremony.
- `apps/web/src/shared/lib/exhaustive.ts` — **new** `assertNever(x: never): never`
  helper used by every exhaustive `switch` per target §2.4.

**Approach.** Per target §8.3 (resolves question 5), the **hybrid**
strategy:

- **Sync mutations** (delete / restore / mark-applied / mark-skipped /
  cancel-stage / cancel-apply / retry-stage with `runAfter: false` /
  update-profile / update-settings / update-credential): optimistic
  via `createOptimisticMutation`; settle invalidation per target §8.2.
- **Async mutations** (generate-materials / apply / dry-run / retry-stage
  with `runAfter: true`): no eager invalidation of the *result*; small
  immediate invalidation of "the request queued" view; real
  invalidation via the SSE invalidation router in Phase 5.

The R12 / R14 `runId` correlation pattern applies symmetrically to
**every** async (202) mutation — Materials AND Apply AND
retry-stage-with-runAfter. Every async mutation hook records the
returned `runId` in the optimistic in-flight cache entry inside
`onMutate`, *before* the network call. The SSE handler matches by
`runId` before applying the invalidation/setQueryData. The
`<GenerateMaterialsButton>` and `<ApplyButton>` both read a
`useIsXxxRunInFlight(jobId)` selector to disable themselves while a
run is active.

The mutation hooks are owned by the aggregate context (Discovery,
Profile, Materials, Apply, Pipeline) per target §3 / §4.4. The view
files in S-15 import them; the views never import
`@jobhunter/api-client` directly.

The placeholder hooks (`useImportJobMutation`,
`useCorrectScoreMutation`, `useEnrichmentRetryMutation`) ship as
files that throw `NotImplementedError`; their existence makes the
context folders complete per target §3.2 / §3.3 / §3.5 / §11
("Eight folders, no inventions, no omissions").

**Tenancy implications.** Every mutation reads `useTenantId()` and
passes it to the invalidation set.

**Acceptance:**

- `pnpm web:check` passes.
- The hooks are importable.
- `createOptimisticMutation` has its own unit test in Phase 6.

**QA checklist:** none — no UI change.

**Deferred follow-ups:** S-15 wires the views to these hooks.

---

#### S-15: refactor(web): rewire every view to hooks; delete useState/useEffect/useRef-requestSeq + sibling-loader callbacks; URL-bind every filter

| Attribute | Detail |
|---|---|
| **Phase** | 3 — Query |
| **Frontend area** | View rewire |
| **Target sections** | §2.1 (rules — no server data in `useState`, no filter `useState`), §4.4 (per-context tactical spec), §4.5 (view composition), §5.2 (URL ↔ cache binding), §6.6 (no `window.dispatchEvent`). |

**Files touched (refactor every view file from S-09):**

- `apps/web/src/views/dashboard/DashboardView.tsx` — **refactor** consume
  `useDashboardSummaryQuery()`, `useApplyRunsListQuery()`; KPI clicks
  navigate via `<Link to="/jobs" search={{ ... }} />`; activity rows
  navigate to `/jobs/$jobId` or `/jobs/$jobId/run/$runId`.
- `apps/web/src/views/jobs/JobsView.tsx` — **refactor** consume
  `useJobsListQuery(useSearch({ from: "/jobs" }))`; **delete**
  `useState<DataShape>`, `useState<loading>`, `useEffect(load)`,
  `useRef(0)` (`requestSeq`), `useCallback(load)` plumbing
  (App.tsx:360-403 equivalents); **delete** `await Promise.all([load(), onJobsChanged()])`-style sibling-loader call sites.
- `apps/web/src/views/jobs/JobsTable.tsx` — **refactor** consume the
  hook's data; sort header buttons call
  `navigate({ search: { ...prev, sort, dir } })` (still hand-rolled —
  TanStack Table v8 lands in Phase 4).
- `apps/web/src/views/jobs/JobFilterBar.tsx` — **refactor** read /
  write URL via `useSearch` + `useNavigate`; **delete** every
  `useState<filterValue>`.
- `apps/web/src/views/jobs/JobBulkActions.tsx` — **refactor** mutations
  call `useDeleteJobsBulkMutation` / `useRestoreJobsBulkMutation`; the
  `selectedJobs` `Set<string>` stays as component `useState` (the
  one documented exception in target §5.1).
- `apps/web/src/views/jobs/JobDetailDrawer.tsx` — **refactor** consume
  `useJobDetailQuery(jobId)`; compose `<JobOverview>`,
  `<ScoreBreakdown>` (S-19), `<StageTimeline>` (S-20),
  `<ArtifactGroup>`, `<ApplyHistory>` (S-19), `<JobActions>` (S-20)
  per target §8.5.
- `apps/web/src/views/artifacts/*.tsx` — **refactor** same pattern.
- `apps/web/src/contexts/profile/components/ProfileEditor.tsx` —
  **refactor** consume `useProfileQuery`; calls to
  `useUpdateProfileMutation` replace the manual `await api.updateProfile`
  + manual reload.
- `apps/web/src/contexts/profile/components/ResumePreviewIframe.tsx`
  — **refactor** read URL from `useProfilePdfPreviewUrl()`.
- `apps/web/src/contexts/profile/components/SettingsPanel.tsx` —
  **refactor** consume `useSettingsQuery` + `useUpdateSettingsMutation`.
- `apps/web/src/contexts/profile/components/CredentialsPanel.tsx`
  — **refactor** consume `useCredentialsQuery` +
  `useUpdateCredentialMutation` + `useDeleteCredentialMutation`.
- `apps/web/src/contexts/profile/components/ResumeImportWizard.tsx`
  — **refactor** confirm step calls `useImportResumeMutation`;
  draft state lives in `profileImportStore` (already wired in S-03).
- `apps/web/src/router.ts` — **refactor** add loaders to `/dashboard`,
  `/jobs`, `/artifacts`, `/profile/index` per target §5.2.
- `apps/web/eslint.config.js` — **refactor** add
  `no-restricted-imports` rule with explicit allow-list per
  target §6.5:
  ```js
  {
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          {
            name: "@jobhunter/api-client",
            message: "Import via usePorts().api (FetchApiClientAdapter wraps it).",
          },
        ],
        patterns: [
          // Forbid projection types from contracts; ACL re-export only.
          {
            group: ["@jobhunter/contracts"],
            importNames: [
              "JobListProjection", "JobDetailProjection", "DashboardProjection",
              "DashboardFunnelStage", "ArtifactListProjection", "ApplyRunProjection",
              "StageProjection",
            ],
            message: "Import projection types from contexts/operations/types.ts (frontend ACL).",
          },
        ],
      }],
    },
  }
  ```
  Allowed `@jobhunter/contracts` imports remain Zod schemas and
  runtime values (`ProfileSchema`, `SettingsUpdateRequestSchema`,
  `CredentialUpdateRequestSchema`, `CredentialKeys`,
  `JsonRpcRequestSchema`, etc.) — used by forms (S-18) and the
  `FetchApiClientAdapter` (S-11). The pattern is precise:
  *projection types only* are forbidden outside the ACL.

  The ESLint rule is scoped to `apps/web/src/contexts/**/*.{ts,tsx}`
  and `apps/web/src/views/**/*.{ts,tsx}`. The exception is
  `apps/web/src/shared/ports/adapters/FetchApiClientAdapter.ts` —
  the only file allowed to import `JobHunterApiClient` directly —
  granted via a separate `overrides` block:
  ```js
  {
    files: ["src/shared/ports/adapters/FetchApiClientAdapter.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  ```
- `apps/web/package.json` — **refactor** add `dependency-cruiser`
  devDependency. ESLint's `no-restricted-imports` does not natively
  enforce per-source-folder restrictions; `dependency-cruiser` is
  the standard tool for cross-folder dependency rules and is the
  R8 mitigation per target §3.10 / §11.
- `apps/web/.dependency-cruiser.cjs` — **new** config:
  ```js
  module.exports = {
    forbidden: [
      {
        name: "no-context-to-view",
        comment: "contexts/* cannot import from views/* (target §3.10).",
        severity: "error",
        from: { path: "^apps/web/src/contexts/" },
        to:   { path: "^apps/web/src/views/" },
      },
      {
        name: "no-view-to-view",
        comment: "views/X cannot import from views/Y (target §3.10).",
        severity: "error",
        from: { path: "^apps/web/src/views/([^/]+)/" },
        to:   { path: "^apps/web/src/views/(?!\\1/).+/" },
      },
      {
        name: "no-view-to-context-internals",
        comment: "views/* may import context COMPONENTS only (not hooks/queryKeys/stores).",
        severity: "warn",
        from: { path: "^apps/web/src/views/" },
        to:   { path: "^apps/web/src/contexts/[^/]+/(hooks|queryKeys|stores|handlers)" },
        // Caveat: views need to call use*Mutation hooks at the boundary
        // (per §4.5 — JobBulkActions calls useDeleteJobsBulkMutation directly).
        // This rule is at "warn" severity; the few legitimate sites add
        // a `// dependency-cruiser-disable-next-line` comment with rationale.
      },
    ],
    options: {
      tsConfig: { fileName: "apps/web/tsconfig.json" },
      doNotFollow: { path: "node_modules" },
    },
  };
  ```
- `apps/web/package.json` — add script
  `"web:depcruise": "depcruise --config .dependency-cruiser.cjs apps/web/src"`.
- CI workflow — **refactor** add `pnpm web:depcruise` step alongside
  `pnpm web:lint`.
- `apps/web/eslint.config.js` — **refactor** add
  `no-restricted-syntax` rule forbidding
  `dispatchEvent(new CustomEvent(...))` outside
  `apps/web/src/shared/ports/adapters/` per target R6 mitigation.
- `package.json` (root or web) — add a CI step
  `pnpm web:lint` that runs the above ESLint config.
- `apps/web/src/shared/lib/cn.ts` — unchanged from S-02 (`twMerge(clsx(...))`).
- The legacy singleton `api` import from `@jobhunter/api-client` is
  **deleted** from every view file; views call ports indirectly via
  hooks per target §4.2 ("a component never imports the
  `QueryClient`, never calls `useQuery` directly, never calls
  `apiClient.*` directly").

**Approach.** This is the largest behavior-preserving refactor in
the migration. Every view's data-fetching surface becomes a
hook-and-mutation surface. Per target §2.1 rules, the *kinds* of
state visible in a view file collapse from
`useState<View|loading|error|data|filter|sort|page|...>`
to:

- `useSearch({ from: "/route" })` for URL state (filter/sort/page).
- `useXxxQuery(input)` for server state.
- `useXxxMutation()` + `mutate(...)` / `mutateAsync(...)` for writes.
- `useState<EphemeralUI>` for the documented exceptions
  (bulk-selection set, "show advanced filters" toggle).

The CI grep guards added here are the long-term enforcement of the
no-strangler discipline:

- `! grep -nrE 'useRef\(0\)' apps/web/src/views apps/web/src/contexts`
  — the `requestSeq` pattern.
- `! grep -nrE 'jobhunter:set-jobs-filter' apps/web/src` — the
  legacy custom event.
- `! grep -nrE 'from "@jobhunter/api-client"' apps/web/src/views apps/web/src/contexts`
  — the legacy direct API import.
- `! grep -nrE 'from "@jobhunter/contracts"' apps/web/src/contexts apps/web/src/views`
  (excluding `contexts/operations/types.ts`).

**Tenancy implications.** None at the view layer — hooks resolve
`tenantId` internally.

**Acceptance:**

- `pnpm web:check`, `pnpm web:build`, `pnpm web:dev`, `pnpm web:lint` all pass.
- React Query Devtools shows every projection cached under
  `["tenant", "local", ...]`.
- Every `useState<{...}|null>(null)` for server data is gone.
- Every `useEffect(load)` is gone.
- Every `useRef(0)` (the `requestSeq` pattern) is gone.
- Every `await Promise.all([load(), onJobsChanged()])` site is gone
  (the dashboard auto-updates because mutation `onSettled`
  invalidates `dashboardKeys.summary`).
- Every URL-state `useState` in views/contexts is gone — concretely:
  `useState<JobSortField>`, `useState<ArtifactSortField>`,
  `useState<Direction>`, the `useState(1)` for `page`, the
  `useState(50)` for `pageSize`, every `useState<Stage | "all">`,
  every `useState<StageState | "all">`, every
  `useState<"active" | "deleted">` (for the deleted toggle), and
  every `useState<filterValue>` (search-string useState).
  CI grep guard:
  `! grep -nrE 'useState<(JobSortField|ArtifactSortField|Direction|Stage|StageState)' apps/web/src/views apps/web/src/contexts`.
  The bulk-selection `Set<string>` and the "show advanced filters"
  toggle stay as ephemeral component `useState` per target §5.1.
- Mutations against jobs / profile / settings / credentials still
  work; UI still updates.

**QA checklist:**

- [ ] Dashboard loads with no spinner if visited recently
  (cache hit); manual reload triggers background refetch.
- [ ] Jobs view: change `stage` filter → URL updates → list
  refetches with new filter; copy URL in new tab → same view; refresh
  → same view.
- [ ] Sort header click changes `sort`/`dir` in URL; list re-sorts.
- [ ] Pagination changes `page` in URL; list refetches.
- [ ] Bulk delete: select 3 jobs → delete → list shows 3 fewer rows
  (optimistic) → no error → background refetch reconciles.
- [ ] Profile edit: change name → save → form returns to non-dirty;
  re-load page → new name persists.
- [ ] Settings save still works.
- [ ] PDF preview iframe `src` updates after profile save (cacheKey
  bumped).
- [ ] Resume import wizard: upload PDF → preview parsed draft →
  confirm → returns to editor; profile reflects imported sections.

**Deferred follow-ups:**

- Phase 4: TanStack Table replaces the hand-rolled sort/select/
  pagination JSX.
- Phase 4: TanStack Form replaces the per-field `useState` draft
  trees in the form components.

---

#### S-16: feat(web): EventStreamProvider scaffold + invalidation router skeleton

| Attribute | Detail |
|---|---|
| **Phase** | 3 — Query |
| **Frontend area** | Realtime scaffold |
| **Target sections** | §3.9 (Operations), §6.4 (`EventStreamPort`), §7.3 (`EventStreamProvider`), §7.4 (router as pure function), §11 (`shared/providers/`). |

**Files touched:**

- `apps/web/src/shared/providers/EventStreamProvider.tsx` — **new**
  per the target §7.3 sketch. In Phase 3, the underlying adapter is
  the Phase-1 stub (`status: "stub"`); the provider mounts but the
  subscription's `on()` never fires. The `<ConnectionStatusPill>`
  reads `status === "stub"` and renders "stub mode".
  **Effect-deps stability:** the `useEffect` that calls
  `eventStream.subscribe(...)` depends on
  `[tenantId, eventStream, queryClient, router]`. Per target §7.3,
  `router` (returned by `useInvalidationRouter()`) **must be a
  module-level singleton** — the hook returns the same reference on
  every call. If a future change ever needs per-tenant routers, the
  hook's signature changes (`useInvalidationRouter(tenantId)`) and
  the singleton becomes a memoized cache; until then, the singleton
  guarantees the effect does not re-run on every render.
- `apps/web/src/contexts/operations/invalidation-router.ts` — **new**
  the pure function per target §7.4. The handler map is typed
  `Record<DomainEvent["type"], InvalidationHandler>` and is
  **populated empty in Phase 3** with each event type mapped to
  `() => []`. Phase 5 (S-20) populates the real handlers.
- `apps/web/src/contexts/discovery/handlers.ts` — **new** placeholder
  handler functions for `JobDiscovered`, `JobUpdated`, `JobDeleted`,
  `JobRestored` per target §11 ("the import path of the handler
  functions is `contexts/<context>/handlers.ts`").
- `apps/web/src/contexts/enrichment/handlers.ts` — **new** placeholders
  for `JobEnriched`, `EnrichmentFailed`.
- `apps/web/src/contexts/scoring/handlers.ts` — **new** placeholders
  for `JobScored`, `ScoreCorrected`.
- `apps/web/src/contexts/materials/handlers.ts` — **new** placeholders
  for `ResumeApproved`, `ResumeFailed`, `CoverLetterGenerated`,
  `PdfRendered`, `MaterialsExhausted`.
- `apps/web/src/contexts/apply/handlers.ts` — **new** placeholders
  for `ApplyRunStarted`, `ApplyRunEventRecorded`,
  `ApplicationSubmitted`, `ApplicationFailed`.
- `apps/web/src/contexts/pipeline/handlers.ts` — **new** placeholders
  for every `Stage*` event.
- `apps/web/src/contexts/profile/handlers.ts` — **new** placeholders
  for `ProfileUpdated`, `ProfileImported`.
- `apps/web/src/routes/__root.tsx` — **refactor** mount
  `<EventStreamProvider>` below `<QueryClientProvider>` and below
  `<TenantProvider>` per target §7.3.

**Approach.** Per target §7.4, the router is a pure function and a
single point to reason about cross-context invalidation. The
compile-time typing (`Record<DomainEvent["type"], InvalidationHandler>`)
is the primary guard that every event variant has a handler entry;
the runtime parity test (Phase 6 S-22) is the backstop that catches
stub bodies. Shipping the empty handlers in Phase 3 means: (a) the
compile-time guard is live from Phase 3; (b) the parity test in
Phase 6 already has something to check; (c) Phase 5 has *only* the
backend endpoint + the handler bodies to add, not the structure.

**Tenancy implications.** Every handler signature receives
`{ tenantId, ... }` from the event payload; the returned key
operations are tenant-scoped via the §4.1 factories.

**Acceptance:**

- `pnpm web:check` passes.
- `<EventStreamProvider>` mounts; `<ConnectionStatusPill>` shows
  "stub mode".
- The empty handler map covers every `DomainEvent["type"]` variant
  (compile-time enforced).

**QA checklist:** confirm pill shows "stub mode"; no console errors.

**Deferred follow-ups:** Phase 5 populates the handlers and replaces
the stub adapter.

**Phase 3 Done When (cumulative across step PRs):**

- All seven step PRs landed in stack order: S-10, S-11, S-12, S-13, S-14, S-15, S-16.
- `pnpm web:check && pnpm web:build && pnpm web:lint && pnpm test` pass on the
  branch after S-16 lands.
- Manual matrix: every flow in `docs/local-reliability-qa.md`.
- React Query Devtools shows tenant-scoped keys for every projection.

---

### Phase 4: Table + Form — TanStack Table v8, TanStack Form

**Motivation.** With Phase 3 complete, the views consume hook data
but still render via hand-rolled sort/select/pagination JSX
(`JobsView` App.tsx:441-493 / 599-651 equivalents in the split files)
and hand-rolled per-field draft/original `useState` form state
(`ConfigView` / `ProfileView` App.tsx:813 equivalent). Target §4.5
specifies TanStack Table v8 for `JobsTable` / `ArtifactsTable`;
target §4.6 specifies TanStack Form (Zod resolvers) for every form.
Both deletions are rip-and-replace per §2 principle 3.

**Scope.** Install `@tanstack/react-table` and `@tanstack/react-form`;
implement column models for jobs and artifacts (cell renderers
imported from the relevant contexts — `<ScoreBadge>` from `scoring`,
`<StageBadge>` from `pipeline`, `<ApplyRunBadge>` from `apply`);
delete hand-rolled sort/select/pagination JSX; ship per-context
domain components and the shared form bindings; rewrite the four
forms (Profile, Settings, Credentials, Resume Import wizard steps);
delete `useState`-per-field draft trees.

**Sequenced steps.**

---

#### S-17: feat(web): JobsTable + ArtifactsTable on TanStack Table v8 + per-context cell renderers (ScoreBadge, StageBadge, ApplyRunBadge, StageTimeline, JobActions, ApplyHistory)

| Attribute | Detail |
|---|---|
| **Phase** | 4 — Table + Form |
| **Frontend area** | Table + per-context badge components |
| **Target sections** | §3.5 (Scoring components), §3.7 (Apply components), §3.8 (Pipeline components), §4.5 (view composition), §11 (`contexts/<name>/components/`). |

**Files touched:**

- `apps/web/package.json` — **refactor** add `@tanstack/react-table`.
- `apps/web/src/views/jobs/JobsTable.tsx` — **refactor** rewrite using
  `useReactTable({ data, columns, state: { sorting }, onSortingChange, manualSorting: true, manualPagination: true, ... })`. Sorting state
  is bound to URL via `useSearch`/`useNavigate`; pagination state same.
  **Delete** the hand-rolled `<button onClick={() => changeSort(...)}>`
  header buttons, the `selectPage` / `selectAllMatching` /
  `clearSelection` helpers (replaced by Table's row-selection API),
  and the inline `<div className="data-row job">` JSX.
- `apps/web/src/views/jobs/columns.ts` — **new** `ColumnDef<JobListProjection>[]`:
  - select column with checkbox cell.
  - fit-score column → `<ScoreBadge>` cell.
  - title column.
  - employer/source column.
  - location column.
  - stage column → `<StageBadge stage={row.currentStage}>`.
  - state column → `<StageBadge state={row.currentState}>`.
  - discovered-at column → `<RelativeTime>`.
- `apps/web/src/views/artifacts/ArtifactsTable.tsx` — **refactor** same
  pattern.
- `apps/web/src/views/artifacts/columns.ts` — **new** `ColumnDef<ArtifactListProjection>[]`
  matching the legacy `ArtifactSortField` set (App.tsx:51-58):
  - select column with checkbox cell.
  - title column (job title) → `<TitleStack>` (job title + employer).
  - employer/source column → `<RelativeTime />` for `createdAt`.
  - type column → `<ArtifactTypeBadge artifactType={row.artifactType}>`
    (`tailored_resume`, `cover_letter`, `resume_pdf`, `cover_letter_pdf`).
  - status column → `<Badge variant={artifactStatusTone(row.status)}>{row.status}</Badge>`
    (`candidate`, `approved`, `rejected`, `superseded`).
  - size column → human-formatted `formatBytes(row.sizeBytes)`.
  - created-at column → `<RelativeTime value={row.createdAt} />`.
  - actions column → `<OpenArtifactButton artifactId={row.artifactId} disabled={row.status === "missing"}>`.
- `apps/web/src/views/jobs/selectors/jobsSelectors.ts` — **new** pure
  helpers per target §11 (e.g., `groupArtifactsByJob`,
  `summarizeFunnel`).
- `apps/web/src/contexts/scoring/components/ScoreBadge.tsx` — **new**
  exhaustive `switch`-based color/score rendering per target §4.4.5.
- `apps/web/src/contexts/scoring/components/ScoreBreakdown.tsx` —
  **new** the breakdown panel for the drawer.
- `apps/web/src/contexts/pipeline/components/StageBadge.tsx` — **new**
  exhaustive `switch` on `state.kind` per target §2.4 / §4.4.8 /
  §10.2 (the parity test in Phase 6 / S-23 enforces every variant
  has a non-default arm).
- `apps/web/src/contexts/pipeline/components/StageTimeline.tsx` —
  **new** vertical list rendered from `JobDetailProjection.stages`.
- `apps/web/src/contexts/pipeline/components/RetryStageButton.tsx` —
  **new** wraps `useRetryStageMutation`.
- `apps/web/src/contexts/pipeline/components/CancelStageButton.tsx` —
  **new** wraps `useCancelStageMutation`.
- `apps/web/src/contexts/pipeline/components/MarkAppliedButton.tsx`,
  `MarkSkippedButton.tsx` — **new**.
- `apps/web/src/contexts/pipeline/components/JobActions.tsx` — **new**
  toolbar composer assembling all per-stage / per-action buttons per
  target §4.4.8.
- `apps/web/src/contexts/apply/components/ApplyButton.tsx`,
  `DryRunButton.tsx`, `CancelApplyButton.tsx`, `ApplyRunBadge.tsx`,
  `ApplyHistory.tsx` — **new** per target §4.4.7.
- `apps/web/src/contexts/apply/components/ApplyRunTimeline.tsx` —
  **moved** from `apps/web/src/views/dashboard/ApplyRunTimeline.tsx`
  (the interim location landed in S-09). Both importers
  (`routes/jobs.$jobId.run.$runId.tsx` and
  `views/dashboard/ApplyRunDrawer.tsx`) update their import paths
  in the same commit. CI grep guard:
  `! grep -nrE 'from "@/views/dashboard/ApplyRunTimeline"' apps/web/src`.
- `apps/web/src/contexts/apply/selectors/applyRunSelectors.ts` —
  **new** the `appendApplyRunEvent(old, event)` helper used by the
  invalidation router's `setQueryData` path per target §7.4.
- `apps/web/src/contexts/materials/components/GenerateMaterialsButton.tsx`,
  `OpenArtifactButton.tsx` — **new** per target §4.4.6.
- `apps/web/src/contexts/discovery/components/JobBulkActions.tsx` —
  the `JobBulkActions` from S-09 stays in `views/jobs/`; the
  *button labels* here are unchanged. (Discovery does not own a
  toolbar component today.)

**Approach.** TanStack Table is headless: the column model is data;
the cell components compose from each context. Per target §4.5 ("a
view file imports *components* from contexts and assembles them"),
`columns.ts` imports `<ScoreBadge>` from `contexts/scoring/`,
`<StageBadge>` from `contexts/pipeline/`, etc. The `JobsTable`
itself owns no domain rendering — it owns the table mechanics
(sorting, pagination, row-selection) and binds the table state to
URL search params.

The exhaustive `switch` on `state.kind` in `<StageBadge>` uses
`assertNever` from `shared/lib/exhaustive.ts` (S-14) so unhandled
variants are TypeScript errors at compile time, per target §2.4.
The Phase 6 stage-state parity test (S-22) catches the case where a
new variant lands with a stub arm.

**Tenancy implications.** None at the cell-renderer layer.

**Acceptance:**

- `pnpm web:check`, `pnpm web:build`, `pnpm web:dev` pass.
- The hand-rolled sort header buttons are gone (CI grep guard:
  `! grep -nrE 'sort-head' apps/web/src`).
- The hand-rolled `select page` / `select all matching` /
  `clear selected` JSX is gone (CI grep guard:
  `! grep -nrE 'select-all-matching' apps/web/src`).
- Sort, select-page, select-all, pagination, and bulk delete all
  behave equivalently to Phase 3.

**QA checklist:**

- [ ] Sort by every column: order is correct in both directions.
- [ ] Page-size selector: 25 / 50 / 100 / 200 each work; URL updates.
- [ ] Page navigation: forward/back; URL updates; refresh keeps page.
- [ ] Row-checkbox: select N → bulk delete → N rows disappear
  (optimistic) → eventual SSE re-confirm.
- [ ] "Select all matching" across multiple pages bulk-deletes the
  full filter set.

**Deferred follow-ups:** none — Phase 4 closes the table refactor.

---

#### S-18: feat(web): TanStack Form for Profile + Settings + Credentials + Resume Import wizard steps

| Attribute | Detail |
|---|---|
| **Phase** | 4 — Table + Form |
| **Frontend area** | Forms |
| **Target sections** | §3.4 (Profile), §4.4.4 (Profile + wizard), §4.6 (TanStack Form decision). |

**Files touched:**

- `apps/web/package.json` — **refactor** add `@tanstack/react-form`
  and `@tanstack/zod-form-adapter`.
- `apps/web/src/shared/ui/form.tsx` — **refactor** wire the TanStack
  Form `useFieldContext` to the shadcn form primitives shipped in
  S-02.
- `apps/web/src/contexts/profile/forms/profile-form.tsx` — **new** uses
  `ProfileSchema` from `@jobhunter/contracts`; `validators: { onSubmit: ProfileSchema }`; on submit calls `useUpdateProfileMutation()`.
- `apps/web/src/contexts/profile/forms/settings-form.tsx` — **new**
  uses `SettingsUpdateRequestSchema`.
- `apps/web/src/contexts/profile/forms/credential-form.tsx` — **new**
  uses `CredentialUpdateRequestSchema`.
- `apps/web/src/contexts/profile/forms/import-upload-form.tsx`,
  `import-preview-form.tsx`, `import-confirm-form.tsx` — **new** the
  three wizard steps; each step's draft state lives in
  `profileImportStore` (Zustand+persist) per target §4.4.4
  (resolution to question 8); the `<form>`s themselves use TanStack
  Form for per-field validation against fragments of
  `ProfileImportRequestSchema`.
- `apps/web/src/contexts/profile/components/ProfileEditor.tsx` —
  **refactor** render `<ProfileForm initial={profile} />` (was
  the per-field `useState` rendering from S-15).
- `apps/web/src/contexts/profile/components/SettingsPanel.tsx` —
  **refactor** render `<SettingsForm />`.
- `apps/web/src/contexts/profile/components/CredentialsPanel.tsx` —
  **refactor** render `<CredentialForm />`.
- `apps/web/src/contexts/profile/components/ResumeImportWizard.tsx` —
  **refactor** wraps the per-step forms.

**Approach.** Per target §4.6, every form's submit handler calls a
mutation hook from the same context. TanStack Form's `form.state.isDirty`,
`form.reset(initial)`, and per-field dirty tracking replace the
hand-rolled draft-vs-original logic from `App.tsx:813` equivalent in
the split files.

The wizard's *draft state* (the parsed-but-not-yet-confirmed profile)
lives in `profileImportStore` (Zustand+persist, version-tagged per
target R11). The wizard's *form validation* (per-field) is TanStack
Form. The two layers cooperate: each step reads/writes the wizard
store, and the form library validates field-by-field on top. This
matches target §4.4.4 ("Step state lives in a Zustand
`profileImportStore` with `persist` middleware so a refresh does not
lose the upload").

**Tenancy implications.** None at the form layer.

**Acceptance:**

- `pnpm web:check`, `pnpm web:build`, `pnpm web:dev` pass.
- Per-field `useState` for draft tracking is gone (CI grep guard:
  `! grep -nrE "useState<.*Draft.*>" apps/web/src/contexts/profile`).
- Profile / Settings / Credentials forms behave equivalently
  (validation, dirty marker, reset, submit).
- Wizard steps validate per field; refresh resumes draft.

**QA checklist:**

- [ ] Profile editor: edit → field shows dirty marker → save →
  optimistic patch → server reconciles; reset works.
- [ ] Settings: each setting's save round-trips.
- [ ] Credentials: add new key → save; delete key.
- [ ] Wizard: upload PDF → preview shows parsed sections → edit a
  parsed entry → confirm; refresh on `/profile/import/preview`
  resumes the draft.

**Deferred follow-ups:** none — Phase 4 closes the form refactor.

**Phase 4 Done When (cumulative across step PRs):**

- Both step PRs landed in stack order: S-17, S-18.
- `pnpm web:check && pnpm web:build && pnpm web:lint && pnpm test` pass on the
  branch after S-18 lands.
- Manual matrix: every flow.

---

### Phase 5: Realtime — Backend SSE Endpoint + Frontend Consumer

**Motivation.** Several POST actions (apply, retry-stage with
`runAfter: true`, generate-materials) return `202 Accepted` and
complete asynchronously in the worker. The UI today has no way to
observe completion other than the user manually refreshing. The
backend already records `JobEvent` rows via `EventPublisher`
(PR #21 / `decisions.md` 2026-05-06 In-Process EventPublisher +
Read-Model Projections). The target §7.1 specifies the SSE endpoint
contract; §7.3 / §7.4 specify the frontend consumer.

**Scope.** Add `GET /v1/events/stream` to `apps/api/src/server.ts` per
target §7.1 (Fastify SSE, Last-Event-ID, keepalive, heartbeat,
tenant scope, `X-Accel-Buffering: no`); replace the Phase 1 stub
`SseEventStreamAdapter` with the real `EventSource` implementation;
populate the invalidation-router handler map per target §7.4 / §8.4;
implement the `setQueryData` path for `ApplyRunEventRecorded` per
target §7.5; implement the connection-status pill / 30s
"connection lost" banner per target §7.7.

**Sequenced steps.**

---

#### S-19: feat(api): add GET /v1/events/stream endpoint per frontend-target.md §7.1

| Attribute | Detail |
|---|---|
| **Phase** | 5 — Realtime |
| **Backend area** | TS API SSE handler |
| **Target sections** | `frontend-target.md` §7.1 (endpoint contract). |

**Files touched:**

- `apps/api/src/server.ts` — **refactor** register a new route
  `GET /v1/events/stream` per target §7.1 contract:
  ```
  Content-Type: text/event-stream
  Cache-Control: no-cache
  X-Accel-Buffering: no
  Connection: keep-alive
  retry: 5000
  : keepalive (every 15s)
  event: heartbeat (every 30s with current watermark)
  event: <DomainEvent["type"]>
  data: <DomainEvent["payload"] as JSON>
  id: <event_id>
  ```
- `apps/api/src/event-stream.ts` — **new** the SSE handler. Tails
  `job_events` for new rows. **Tenant filtering must work without a
  `tenant_id` column on `job_events`** — the column does not exist
  in the current schema (`workers/automation/src/jobhunter/database.py:370-381`).
  The plan picks **option (b)**: filter via
  `JSON_EXTRACT(payload_json, '$.tenantId') = :tenantId`, with a
  supporting expression index added in this step:
  ```sql
  CREATE INDEX IF NOT EXISTS idx_job_events_tenant_eid
    ON job_events(JSON_EXTRACT(payload_json, '$.tenantId'), event_id);
  ```
  The full tail query is:
  ```sql
  SELECT event_id, event_type, payload_json, occurred_at
  FROM job_events
  WHERE event_id > :resumeFrom
    AND JSON_EXTRACT(payload_json, '$.tenantId') = :tenantId
  ORDER BY event_id ASC
  LIMIT 1000;
  ```
  `resumeFrom` resolves from `Last-Event-ID` header (preferred) →
  `?since` query string (fallback) → `current_max(event_id)`
  (default if neither). Rows whose `payload_json.tenantId` is
  `NULL` (legacy rows pre-DDD migration) are filtered out — local
  mode has only `LOCAL_TENANT` so this is a no-op today.

  **Why not the column-add approach (option a):** adding
  `tenant_id` to `job_events` requires a worker-side change to
  `record_job_event` plus a backfill, expanding S-19 scope from
  "ship the SSE endpoint" to "migrate `job_events` schema." The
  tenant scope is already in `payload_json.tenantId` for every
  event written post-DDD-migration (per the
  `EventPublisher` contract in `decisions.md` 2026-05-06
  In-Process EventPublisher), so JSON_EXTRACT is the right
  local-mode answer.

  **Why not defer entirely (option c):** target §7.1 marks
  tenant scope as **mandatory** ("the server enforces that
  returned events match `:tenantId`"); deferring would violate
  the target.

  **Multi-tenant evolution:** when the hosted multi-tenant
  switcher ships (target §9.4), this query swaps for a
  `tenant_id` column with proper backfill — same `EventStreamPort`
  interface; the change is invisible to the frontend.
- `apps/api/src/contracts.ts` — **refactor** export an `EventSseQuerySchema`
  (Zod) for `?tenantId` and `?since`.
- `apps/api/test/event-stream.test.ts` — **new** test boot of the
  Fastify app: open EventSource client → insert `job_events` row →
  receive within < 500 ms → close → reconnect with
  `Last-Event-ID: <prev_id>` → resume from next.
- `apps/api/test/server.test.ts` — **refactor** add smoke test that
  `/v1/events/stream` responds with `Content-Type: text/event-stream`.
- `docs/local-ts-api.md` — **refactor** document the new endpoint.

**Approach.** Per target §7.1, SSE on a dedicated endpoint is the
correct transport for a unidirectional fanout from the worker's
`job_events` to the browser. Fastify supports streaming
`text/event-stream` responses with backpressure; no extra runtime is
needed. The `Last-Event-ID` header (set automatically by the browser
on auto-reconnect) is the resume mechanism; the `?since` query
string is the first-connect fallback for the IndexedDB-cache-hydration
evolution path (target §9.7), which is named-not-built.

**Tail-loop architecture.** `better-sqlite3` (the existing
`apps/api/src/db.ts` driver) does not expose `update_hook()` to JS,
and SQLite has no `LISTEN/NOTIFY`. The handler runs **a single shared
poll loop in the apps/api process**, polling `job_events` every
250ms (configurable via `JOBHUNTER_API_SSE_POLL_MS`). New rows are
fanned out to every connected `EventSource` subscriber for that
tenant. This is O(1) polls regardless of subscriber count (one tab,
one hundred tabs, the loop runs the same way; per-subscriber
state is just a current-watermark cursor). WAL mode (already
enabled per `apps/api/src/db.ts`) ensures the `apps/api` process
sees writes committed by the Python worker without explicit
synchronization. The poll loop starts on the first subscriber
connection and stops 30s after the last subscriber disconnects
(idle-timeout to avoid empty polling). Multi-process backend
deployments (out-of-scope per target §9.1+) replace the poll loop
with an outbox-driven adapter.

The endpoint enforces tenant scope: in local mode `LOCAL_TENANT`; in
hosted mode the server resolves `tenantId` from JWT and rejects
mismatched query-string values per target §7.1 server-side
responsibilities.

`X-Accel-Buffering: no` disables nginx buffering at the edge per
target R3 mitigations.

**Tenancy implications.** Endpoint is parameterized by `tenantId`;
server enforces match.

**Acceptance:**

- `pnpm api:check`, `pnpm api:test`, `pnpm test` pass.
- `curl -N http://127.0.0.1:8766/v1/events/stream?tenantId=local`
  receives the keepalive comment within 15s.
- Inserting a `job_events` row directly into the SQLite DB causes
  the `curl` stream to receive an `event: <type>` line within
  500 ms.

**QA checklist:**

- [ ] EventSource opens against the local dev API; browser network
  panel shows `text/event-stream`.
- [ ] Killing the API → browser EventSource auto-reconnects when
  API restarts; `Last-Event-ID` header is sent.

**Deferred follow-ups:** S-20 wires the frontend consumer.

---

#### S-20: feat(web): real SseEventStreamAdapter + populated invalidation router + connection banner

| Attribute | Detail |
|---|---|
| **Phase** | 5 — Realtime |
| **Frontend area** | SSE consumer + invalidation handlers |
| **Target sections** | §3.9 (Operations), §6.4 (`EventStreamPort`), §7 (entire realtime section), §8.4 (event → invalidation map). |

**Files touched:**

- `apps/web/src/shared/ports/adapters/SseEventStreamAdapter.ts` —
  **refactor** replace the Phase-1 stub. Opens
  `new EventSource(<baseUrl>/v1/events/stream?tenantId=<tid>)` once
  per tab when the application mounts; subscribes handlers to
  `EventSource` events; exposes `status: "connecting" | "open" | "closed" | "degraded"`;
  parses each event via `parseDomainEvent` (Zod). On parse failure,
  log via `usePorts().telemetry.error(...)` and drop per target §7.2.
- `apps/web/src/shared/ports/lib/parseDomainEvent.ts` — **new** Zod
  schemas mirrored from `@jobhunter/domain-types/events/`; strict
  Zod (unknown fields rejected) per target R7.
- `apps/web/src/contexts/operations/invalidation-router.ts` —
  **refactor** populate the handler map per target §8.4 (full event →
  invalidation map):
  - `JobDiscovered` → invalidate `jobsKeys.lists(tid)`,
    `dashboardKeys.summary(tid)`.
  - `JobUpdated`, `JobDeleted`, `JobRestored` → invalidate
    `jobsKeys.lists(tid)`, `jobsKeys.detail(tid, jobId)`,
    `dashboardKeys.summary(tid)` for the deletion ones.
  - `JobEnriched`, `EnrichmentFailed`, `JobScored`, `ScoreCorrected`,
    `ResumeApproved`, `ResumeFailed`, `CoverLetterGenerated`,
    `PdfRendered`, `MaterialsExhausted` → invalidate per target §8.4.
  - `ApplyRunStarted`, `ApplicationSubmitted`, `ApplicationFailed` →
    invalidate per §8.4.
  - `ApplyRunEventRecorded` → `setQueryData(applyRunsKeys.detail(tid, runId), appendApplyRunEvent(old, event))`
    per target §7.5 / §7.4.
  - `StageStarted`, `StageCompleted`, `StageFailed`, `StageBlocked`,
    `StageSkipped`, `StageReset`, `StageCanceled`, `StageExhausted`
    → invalidate `jobsKeys.lists(tid)`, `jobsKeys.detail(tid, jobId)`,
    `dashboardKeys.summary(tid)` per §8.4.
  - `ProfileUpdated`, `ProfileImported` → invalidate
    `profileKeys.profile(tid)` per §8.4.
- `apps/web/src/contexts/<context>/handlers.ts` — **refactor** each
  context's handlers ship with real bodies; the router imports them
  via the registry.
- `apps/web/src/shared/layout/ConnectionStatusPill.tsx` — **refactor**
  render `live` / `reconnecting` / `degraded`; on `closed > 30s`,
  render banner "Connection lost — events paused; data will refresh
  when reconnected" per target §7.7.
- `apps/web/src/shared/providers/EventStreamProvider.tsx` — **refactor**
  on `status === "open"` after a previous `"closed" | "degraded"` →
  trigger one-shot `queryClient.invalidateQueries()` (full cache
  invalidation) per target §7.7 backstop.
- `apps/web/src/contexts/apply/selectors/applyRunSelectors.ts` —
  **refactor** flesh out `appendApplyRunEvent(old, event)` per
  target §7.4.
- `apps/web/src/contexts/operations/hooks/useHealthQuery.ts` —
  **refactor** the SSE heartbeat (every 30s per target §7.1) is now
  the authoritative liveness signal. The HTTP polling is reduced to
  a low-frequency backstop:
  - When `useEventStream().status === "open"`,
    `useHealthQuery({ refetchInterval: false })` — disable polling
    entirely; SSE heartbeat covers liveness.
  - When status is `"connecting" | "closed" | "degraded"`,
    `refetchInterval: 30_000` — slow poll as a backstop while SSE
    is unhealthy.
  This deletes the Phase 3 hard-coded `refetchInterval: 15_000`
  (S-13) on the same cut-over.

**Approach.** Per target §7.4, each new backend `DomainEvent`
variant must produce a TypeScript compile error in `apps/web` until
a handler is wired (the
`Record<DomainEvent["type"], InvalidationHandler>` typing). Phase 3
already shipped the empty handler shape; this step fills it. Phase 6's
`every-event-has-handler.test.ts` parity test guards against stub
bodies surviving CI.

The `setQueryData` path for `ApplyRunEventRecorded` is the *only*
exception to the "invalidate by default" rule per target §7.5 —
event volume during an apply run is several events per second over
minutes; refetching per event would saturate the API.

The 30s "connection lost" banner is the visible mitigation for
target R3 (SSE proxy buffering / silent stream pauses).

**Tenancy implications.** The `EventStreamProvider` is parameterized
by `tenantId`; cross-tenant cache leak is impossible because every
key is tenant-prefixed (target §7.8).

**Acceptance:**

- `pnpm web:check`, `pnpm web:build` pass.
- `pnpm api:dev` + `pnpm web:dev`: triggering an apply action updates
  the dashboard / job drawer / artifacts list within ≤ 1s without
  refresh.
- Killing the API process flips the connection-status pill to
  "reconnecting" within ≤ 30s and back to "live" on restart.
- Dropping the connection for > 30s shows the "Connection lost"
  banner; reconnect triggers a one-shot full cache invalidation.

**QA checklist:**

- [ ] Click "apply" on a job → dashboard apply-runs card shows the
  new run within 1s; no manual refresh required.
- [ ] Apply-run drawer's timeline appends events as they arrive
  (one event every ~2s during the run).
- [ ] Apply completes → dashboard funnel updates within 1s; jobs
  list shows the new "applied" stage state for the job.
- [ ] Generate materials → drawer shows "queued" → SSE
  `ResumeApproved` event flips drawer to "approved" status.
- [ ] Score correction (placeholder hook unused, but the SSE event
  taxonomy includes `ScoreCorrected` for forward-compat).

**Deferred follow-ups:**

- Phase 6 ships the parity tests + invalidation-router unit tests.
- Phase 6 ships the Playwright E2E that exercises apply → SSE.

**Phase 5 Done When (cumulative across step PRs):**

- Both step PRs landed in stack order: S-19, S-20.
- `pnpm api:check && pnpm api:test && pnpm web:check && pnpm web:build && pnpm web:lint && pnpm test` pass on the
  branch after S-20 lands.
- Manual matrix: every flow + the SSE-driven flows above.

---

### Phase 6: Testing Harness — Vitest, RTL, MSW, Playwright, Parity Tests

**Motivation.** The frontend has zero tests today. Target §10
specifies the test pyramid: Vitest unit tests (query-key factories,
invalidation router, selectors, Zod schemas), Vitest + RTL + MSW
integration tests (every hook, components with non-trivial
interaction), Playwright E2E for eight critical flows, two parity
tests, `tsd` type-level tests, and `axe-core` for form / dialog
spot-checks. The invalidation router is "the most important unit
test in the app" per target §10.2.

**Scope.** Install Vitest + RTL + MSW + Playwright + tsd + axe-core;
ship test setup files; ship handlers per backend route; ship
fixtures for projections and events; ship the unit tests, hook
tests, component tests, parity tests, and Playwright specs.

**Sequenced steps.**

---

#### S-21: chore(web): install Vitest + RTL + MSW + jsdom; ship MSW handlers + fixtures + setup; CI integration

| Attribute | Detail |
|---|---|
| **Phase** | 6 — Testing |
| **Frontend area** | Test infrastructure |
| **Target sections** | §10.3 (RTL + MSW), §10.9 (CI). |

**Files touched:**

- `apps/web/package.json` — **refactor** add `vitest`,
  `@testing-library/react`, `@testing-library/user-event`,
  `@testing-library/jest-dom`, `jsdom`, `msw`, `@vitest/coverage-v8`.
  Add scripts `web:test`, `web:test:watch`, `web:test:coverage`.
- `apps/web/vitest.config.ts` — **new** environment: `jsdom`,
  setupFiles: `./src/test/setup.ts`, globals: true,
  coverage thresholds (target later — start at 50% statements).
- `apps/web/src/test/setup.ts` — **new** `@testing-library/jest-dom`
  matchers; MSW server `beforeAll(() => server.listen())`,
  `afterEach(() => server.resetHandlers())`,
  `afterAll(() => server.close())`.
- `apps/web/src/test/msw/handlers.ts` — **new** one MSW handler per
  backend route mirroring `packages/api-client`; default response
  shapes from `apps/web/src/test/fixtures/projections.ts`.
- `apps/web/src/test/msw/sse-handlers.ts` — **new** SSE mock via
  MSW's experimental SSE support; if it proves limiting, tests
  inject a `EventStreamPort` mock through `<PortsProvider>` per
  target §10.3.
- `apps/web/src/test/msw/server.ts` — **new** `setupServer(...handlers)`.
- `apps/web/src/test/fixtures/projections.ts` — **new** canonical
  sample `JobListProjection`, `JobDetailProjection`,
  `DashboardProjection`, `ArtifactListProjection`,
  `ApplyRunProjection` rows; one of each kind per backend variant.
- `apps/web/src/test/fixtures/events.ts` — **new** canonical
  `DomainEvent` samples for every variant.
- `apps/web/src/test/render.tsx` — **new** `renderWithProviders` test
  helper that wraps the component in `<PortsProvider mocks={...}>`,
  `<QueryClientProvider>`, `<TenantProvider>`, `<ThemeProvider>`,
  `<DensityProvider>`, `<RouterProvider>` (with a memory router for
  most tests).
- `package.json` (root) — **refactor** the `pnpm test` script runs
  `pnpm -r test` covering `apps/api`, `apps/web`, `packages/*`.
- `.github/workflows/ci.yml` (or equivalent) — **refactor** add the
  `pnpm web:test` step.

**Approach.** Per target §10.3, MSW is the integration-test default
because it mocks at the fetch layer (the same layer
`@jobhunter/api-client` uses). The `EventStreamPort` mock injection
is the SSE-test fallback if MSW SSE proves limiting. The
`renderWithProviders` helper centralizes the provider tree so each
test file does not re-assemble it.

**Tenancy implications.** Tests pass `LOCAL_TENANT`; multi-tenant
test cases land when the hosted adapter does.

**Acceptance:**

- `pnpm web:test` runs (and trivially passes — only setup).
- CI runs the test step.

**QA checklist:** none — infrastructure only.

**Deferred follow-ups:** S-23, S-24, S-25, S-26.

---

#### S-22: feat(web): unit tests for query-key factories + invalidation router + parity tests + selectors + Zod schemas

| Attribute | Detail |
|---|---|
| **Phase** | 6 — Testing |
| **Frontend area** | Unit tests |
| **Target sections** | §7.4 (event-handler parity test as fitness function), §10.2 (unit-test catalog including the two parity tests). |

**Files touched (every file is **new**):**

- `apps/web/src/contexts/operations/queryKeys.test.ts` — assert
  structural equality of generated keys for representative inputs;
  every key starts with `["tenant", LOCAL_TENANT, ...]`.
- `apps/web/src/contexts/operations/invalidation-router.test.ts` —
  one test per backend `DomainEvent` variant; assert exact set of
  `invalidateQueries` and `setQueryData` calls per target §10.2
  ("the most important unit test in the app"). Mock the
  `QueryClient` and assert against its received calls.
- `apps/web/src/contexts/operations/every-event-has-handler.test.ts`
  — the **first parity test** per target §7.4 / §10.2. Iterates
  the `DomainEvent["type"]` union (extracted via the Zod
  discriminated-union schema's `.options` array) and asserts a
  handler is registered. Inspects the source of `handlers` for the
  new event and fails CI if the body is the obvious empty stub
  (`() => []`). Mirror of backend's
  `scripts/check-domain-type-parity.py`.
- `apps/web/src/contexts/pipeline/components/StageBadge.test.tsx` —
  one test per `STAGE_STATE_KINDS` value; assert the rendered
  fragment is non-default.
- `apps/web/src/contexts/pipeline/components/every-stage-state-has-badge.test.ts`
  — the **second parity test** per target §10.2. Iterates
  `STAGE_STATE_KINDS` (from `@jobhunter/domain-types/pipeline`) and
  asserts `<StageBadge>` renders a non-default arm for every kind.
- `apps/web/src/views/jobs/selectors/jobsSelectors.test.ts` — pure
  selector tests.
- `apps/web/src/contexts/apply/selectors/applyRunSelectors.test.ts`
  — `appendApplyRunEvent` round-trip tests.
- `apps/web/src/shared/lib/createOptimisticMutation.test.ts` —
  asserts the snapshot → patch → rollback → invalidate sequence per
  target R2.
- `apps/web/src/shared/ports/lib/parseDomainEvent.test.ts` —
  round-trip a JSON event → parsed → JSON.

**Approach.** The parity tests are CI-enforced fitness functions
per target §7.4. The router unit test asserts the contract surface
between the backend's events and the frontend's cache. Selector
tests cover the pure helpers used by views and the
`setQueryData` paths.

**Tenancy implications.** Tests use `LOCAL_TENANT`.

**Acceptance:**

- `pnpm web:test` passes.
- Adding a stub handler `() => []` for a new event variant fails
  the parity test.
- Adding a new `STAGE_STATE_KINDS` value fails the badge parity test
  until `<StageBadge>` covers it.

**QA checklist:** none — automated.

**Deferred follow-ups:** S-24, S-25.

---

#### S-23: feat(web): hook tests with MSW + component tests for filter bar / bulk actions / apply timeline

| Attribute | Detail |
|---|---|
| **Phase** | 6 — Testing |
| **Frontend area** | Integration tests |
| **Target sections** | §10.3 (hook + component tests). |

**Files touched (every file is **new**):**

- `apps/web/src/contexts/operations/hooks/*.test.ts` — one test per
  read hook: assert the hook calls the right `api` method, returns
  the typed shape, and reflects MSW handler responses.
- `apps/web/src/contexts/<aggregate>/hooks/*.test.ts` — one test per
  mutation hook: assert it calls the right `api` method, applies the
  optimistic patch in `onMutate`, rolls back in `onError`, and
  invalidates the right keys in `onSettled` per target §10.3.
- `apps/web/src/views/jobs/JobFilterBar.test.tsx` — render in a
  memory router; change `stage` filter via `userEvent.selectOptions`;
  assert URL updates; assert the dependent query refetches.
- `apps/web/src/views/jobs/JobBulkActions.test.tsx` — select 3 rows
  via checkboxes; click bulk delete; confirm; assert MSW handler
  received the bulk-delete request.
- `apps/web/src/contexts/apply/components/ApplyRunTimeline.test.tsx`
  — render with a mocked `EventStreamPort` that emits 5 sequential
  `ApplyRunEventRecorded` events; assert the timeline appends each
  via `setQueryData`.
- `apps/web/src/shared/providers/EventStreamProvider.test.tsx` —
  mount with a mocked port; assert subscribe is called; assert the
  invalidation router is called for each event.
- `apps/web/src/contexts/operations/sse-integration.test.ts` — **new**
  the **integration test that bridges S-19 (backend SSE endpoint)
  and S-20 (frontend consumer)** that the original draft missed.
  Two layers possible (pick whichever the implementer can stand
  up easily):
  - **(a) MSW SSE handler** — install an MSW handler that streams
    canned SSE frames matching `apps/api`'s endpoint contract; open
    the real `SseEventStreamAdapter` against that handler; assert
    `parseDomainEvent` parses each frame and the invalidation
    router receives the typed event AND invalidates the expected
    keys for one event of each variant.
  - **(b) In-memory Fastify boot** — boot the real `apps/api`
    Fastify app against a temp SQLite DB; insert one
    `job_events` row per `DomainEvent["type"]` variant; open the
    real `SseEventStreamAdapter` against the booted endpoint;
    assert the invalidation router fires for each.

  Either layer catches a regression where the SSE event-name
  encoding doesn't match the frontend's Zod schema, the JSON_EXTRACT
  tenant filter has a typo, or the row order is wrong — without
  having to wait for Playwright (slow, flaky). This sits between
  the per-event router unit test (S-22) and the Playwright E2E
  (S-24).

**Approach.** Per target §10.3 (resolves question 14), hook tests
with MSW are fast and run on every PR — they catch ~90% of
regressions and pin the hook contract. They use `renderHook` from
`@testing-library/react` wrapped in `renderWithProviders`. Component
tests use `userEvent` for interactions and `screen.findBy*` for
assertions to avoid flakiness.

**Tenancy implications.** Tests use `LOCAL_TENANT`.

**Acceptance:**

- `pnpm web:test` passes.
- Coverage > 70% for `contexts/operations/hooks/`,
  `contexts/<aggregate>/hooks/`, `views/jobs/`,
  `views/artifacts/`, `contexts/profile/forms/`.

**QA checklist:** none — automated.

**Deferred follow-ups:** S-25.

---

#### S-24: chore(web): add Playwright + per-test isolated SQLite + 8 critical flows

| Attribute | Detail |
|---|---|
| **Phase** | 6 — Testing |
| **Frontend area** | E2E tests |
| **Target sections** | §10.4 (Playwright critical flows — eight specified). |

**Files touched:**

- `apps/web/package.json` — **refactor** add `@playwright/test`. Add
  `web:e2e`, `web:e2e:headed` scripts.
- `apps/web/e2e/playwright.config.ts` — **new** configures Chromium
  / Firefox / WebKit; baseURL `http://127.0.0.1:5173`; per-test
  isolated SQLite seeded from `e2e/fixtures/`.
- `apps/web/e2e/fixtures/seed.sql` — **new** canonical seed data:
  10 jobs across stages, 3 artifacts, 1 apply run, 1 profile.
- `apps/web/e2e/fixtures/global-setup.ts` — **new** copies the seed
  to `~/.jobhunter-e2e-${RANDOM}/jobhunter.db`; sets
  `JOBHUNTER_DB_PATH` env; spawns `pnpm api:dev` + `pnpm web:dev`;
  waits for `/v1/health` and `http://127.0.0.1:5173`.
- `apps/web/e2e/tests/dashboard.spec.ts` — flow #1 (Dashboard load
  → KPI click → filtered jobs view → row count).
- `apps/web/e2e/tests/jobs-drawer.spec.ts` — flow #2 (open drawer,
  refresh, close).
- `apps/web/e2e/tests/jobs-bulk.spec.ts` — flow #3 (bulk soft-delete +
  restore).
- `apps/web/e2e/tests/profile-edit.spec.ts` — flow #4 (profile edit
  + PDF preview).
- `apps/web/e2e/tests/wizard.spec.ts` — flow #5 (resume import wizard).
- `apps/web/e2e/tests/materials.spec.ts` — flow #6 (generate
  materials → SSE `ResumeApproved`).
- `apps/web/e2e/tests/dry-run.spec.ts` — flow #7 (dry-run apply
  with timeline + simulated `DryRunComplete`).
- `apps/web/e2e/tests/settings.spec.ts` — flow #8 (settings update
  + persistence).
- `.github/workflows/ci.yml` — **refactor** add `pnpm web:e2e` job.

**Approach.** Per target §10.4, E2E catches real-browser issues
(router navigation, SSE connection, focus management) that MSW
cannot. Per-test isolated SQLite avoids cross-test interference and
keeps the suite hermetic.

For SSE-dependent flows (#6 generate-materials, #7 dry-run), the
test seeds the `job_events` table directly via SQLite to inject
`ResumeApproved` / `DryRunComplete` events; the SSE endpoint streams
them; the UI updates; the test asserts the updated state.

**Tenancy implications.** Tests use `LOCAL_TENANT`.

**Acceptance:**

- `pnpm web:e2e` passes locally.
- CI runs the suite headless on PR.

**QA checklist:** none — automated.

**Deferred follow-ups:** S-26.

---

#### S-25: feat(web): tsd type tests + axe-core for form/dialog components

| Attribute | Detail |
|---|---|
| **Phase** | 6 — Testing |
| **Frontend area** | Type + a11y tests |
| **Target sections** | §10.6 (type-level tests), §10.7 (a11y). |

**Files touched:**

- `apps/web/package.json` — **refactor** add `tsd`, `jest-axe`,
  `@axe-core/react`.
- `apps/web/src/contexts/operations/hooks/useJobsListQuery.test-d.ts`
  — **new** assert
  `expectType<UseQueryResult<PaginatedResponse<JobListProjection>>>(useJobsListQuery(input))`.
- One `*.test-d.ts` per Operations read hook.
- `apps/web/src/contexts/profile/forms/profile-form.a11y.test.tsx`
  — **new** render the form; assert no critical axe violations.
- One `*.a11y.test.tsx` per form + per `<Dialog>` / `<Drawer>` /
  `<Sheet>`-rendering component.
- `apps/web/package.json` — add script `web:test-d` running `tsd`.
- CI workflow — add `pnpm web:test-d` step.

**Approach.** `tsd` catches accidental widening of inferred hook
types (e.g., to `UseQueryResult<unknown>`). `axe-core` covers the
"no critical violations" bar for form / dialog surfaces per target
§10.7; broader audits are a dedicated phase per target §1 Non-Goals.

**Tenancy implications.** None.

**Acceptance:**

- `pnpm web:test-d` passes.
- Axe a11y tests pass with zero critical violations.

**QA checklist:** none — automated.

**Deferred follow-ups:** none.

**Phase 6 Done When (cumulative across step PRs):**

- All five step PRs landed in stack order: S-21, S-22, S-23, S-24, S-25.
- `pnpm web:test && pnpm web:test-d && pnpm web:e2e` pass locally.
- CI green on a PR with deliberate handler-stub regression — the
  parity test fails as designed.
- CI green on a PR adding a new `STAGE_STATE_KINDS` value without
  updating `<StageBadge>` — the parity test fails as designed.

---

### Phase 7: Storybook + Per-Context Stories + a11y Baseline

**Motivation.** Per target §10.5, Storybook serves three audiences:
developers (visual playground), designers (review surface without
booting the full app), and visual regression (Chromatic / Loki
snapshots). The per-context domain components (`<ScoreBadge>`,
`<StageBadge>`, `<ApplyRunBadge>`, `<JobActions>`) become much easier
to maintain when their states are enumerable. The visual-regression
snapshotter is **named-not-built** — Chromatic/Loki integration is a
one-line CI change when the user wants it.

**Scope.** Install Storybook + `@storybook/react-vite` +
`@storybook/addon-a11y` + `@storybook/addon-msw`; ship one story per
shadcn primitive in `shared/ui/`; ship one story per per-context
domain component; ship one story per view; configure the a11y addon
to fail on critical violations.

**Sequenced steps.**

---

#### S-26: chore(web): install Storybook + addons; ship per-shared/ui stories

| Attribute | Detail |
|---|---|
| **Phase** | 7 — Storybook |
| **Frontend area** | Storybook setup + primitive stories |
| **Target sections** | §10.5 (Storybook + visual regression). |

**Files touched:**

- `apps/web/package.json` — **refactor** add `storybook`,
  `@storybook/react-vite`, `@storybook/addon-essentials`,
  `@storybook/addon-a11y`, `msw-storybook-addon`.
- `apps/web/.storybook/main.ts` — **new** Vite framework, MDX support,
  addons.
- `apps/web/.storybook/preview.tsx` — **new** wraps every story in
  `<PortsProvider>`, `<TenantProvider>`, `<ThemeProvider>`,
  `<DensityProvider>`, `<QueryClientProvider>`, `<MemoryRouterProvider>`;
  initializes MSW addon with default handlers from
  `src/test/msw/handlers.ts`.
- `apps/web/src/shared/ui/button.stories.tsx` — **new** variants:
  default, destructive, outline, ghost, secondary; sizes: sm, default, lg.
- `apps/web/src/shared/ui/dialog.stories.tsx` — **new** open/closed.
- `apps/web/src/shared/ui/drawer.stories.tsx`,
  `sheet.stories.tsx`, `dropdown-menu.stories.tsx`,
  `select.stories.tsx`, `command.stories.tsx`,
  `tabs.stories.tsx`, `toast.stories.tsx`, `tooltip.stories.tsx`,
  `skeleton.stories.tsx`, `input.stories.tsx`, `textarea.stories.tsx`,
  `checkbox.stories.tsx`, `switch.stories.tsx`, `badge.stories.tsx`,
  `card.stories.tsx`, `copyable-command.stories.tsx` — **new** one
  story file per primitive.

**Approach.** Co-located `*.stories.tsx` per target §10.5. The MSW
addon supplies fake API responses to story states (loading /
populated / empty / error) per target §10.5 ("a story for
`<JobsTable />` can show the loading, populated, and empty states
without booting the real backend").

The visual-regression snapshotter is **named in the README** but
not wired. When the user wants it, the swap is:
- Chromatic: add `npx chromatic --project-token=...` to CI; one line.
- Loki: add `loki test` to CI; ~5-line config file.

**Tenancy implications.** Stories use `LOCAL_TENANT`.

**Acceptance:**

- `pnpm web:storybook` runs locally.
- `pnpm web:storybook:build` produces a static build.
- `.storybook/manager.html` lists every primitive story.

**QA checklist:** none — visual.

**Deferred follow-ups:** S-27.

---

#### S-27: feat(web): per-context domain stories + view stories + a11y addon enforcement

| Attribute | Detail |
|---|---|
| **Phase** | 7 — Storybook |
| **Frontend area** | Per-context stories |
| **Target sections** | §10.5 (Storybook), §10.7 (a11y). |

**Files touched (every file is **new**):**

- `apps/web/src/contexts/scoring/components/ScoreBadge.stories.tsx` —
  one story per integer 1..10.
- `apps/web/src/contexts/scoring/components/ScoreBreakdown.stories.tsx`.
- `apps/web/src/contexts/pipeline/components/StageBadge.stories.tsx`
  — one story per `STAGE_STATE_KINDS` value.
- `apps/web/src/contexts/pipeline/components/StageTimeline.stories.tsx`,
  `JobActions.stories.tsx`, `RetryStageButton.stories.tsx`,
  `CancelStageButton.stories.tsx`, `MarkAppliedButton.stories.tsx`,
  `MarkSkippedButton.stories.tsx`.
- `apps/web/src/contexts/apply/components/*.stories.tsx` — one per
  `ApplyButton`, `DryRunButton`, `CancelApplyButton`,
  `ApplyRunBadge`, `ApplyRunTimeline`, `ApplyHistory`.
- `apps/web/src/contexts/materials/components/*.stories.tsx`.
- `apps/web/src/contexts/profile/components/ProfileEditor.stories.tsx`,
  `ResumePreviewIframe.stories.tsx`,
  `ResumeImportWizard.stories.tsx`, `SettingsPanel.stories.tsx`,
  `CredentialsPanel.stories.tsx`.
- `apps/web/src/views/dashboard/DashboardView.stories.tsx`,
  `KpiGrid.stories.tsx`, `Funnel.stories.tsx`,
  `ActivityFeed.stories.tsx`, `ApplyRunsCard.stories.tsx`.
- `apps/web/src/views/jobs/JobsView.stories.tsx`,
  `JobsTable.stories.tsx`, `JobDetailDrawer.stories.tsx`,
  `JobFilterBar.stories.tsx`, `JobBulkActions.stories.tsx`.
- `apps/web/src/views/artifacts/ArtifactsView.stories.tsx`,
  `ArtifactsTable.stories.tsx`, `ArtifactDetailPanel.stories.tsx`,
  `ArtifactFilterBar.stories.tsx`.
- `apps/web/.storybook/preview.tsx` — **refactor** configure
  `addon-a11y` parameters to fail on critical violations
  (`a11y: { test: "error" }`).
- `apps/web/package.json` — script `web:storybook:test` runs
  `storybook test` (or `test-storybook`) which runs the a11y addon
  in CI.
- `.github/workflows/ci.yml` — **refactor** add
  `pnpm web:storybook:build && pnpm web:storybook:test`.

**Approach.** Per target §10.5 / §10.7, axe-core via the addon-a11y
fails CI on critical violations across every form / dialog story.
Per-state stories (loading / populated / empty / error) for
data-driven views use the MSW addon to inject the fixture responses
from `src/test/fixtures/projections.ts`.

**Tenancy implications.** Stories use `LOCAL_TENANT`.

**Acceptance:**

- Storybook builds locally; CI builds + a11y-tests it.
- `<StageBadge>` story has one entry per `STAGE_STATE_KINDS` value.
- All form/dialog stories pass a11y critical-violations bar.

**QA checklist:** open Storybook locally; review a few stories.

**Deferred follow-ups:** Chromatic / Loki visual regression hookup.

**Phase 7 Done When (cumulative across step PRs):**

- Both step PRs landed in stack order: S-26, S-27.
- `pnpm web:storybook:build && pnpm web:storybook:test` pass in CI.

---

### Phase 8: Documentation, ADRs, Glossary, Plan Move

**Motivation.** With Phases 1–7 complete, the implemented state
matches the target. Docs need to reflect that. Per AGENTS.md
("Documentation Requirements"), every doc that owns a touched
surface must be updated.

**Scope.** Update every relevant doc; add four ADRs to
`decisions.md`; move this plan from `proposed/` to `implemented/`;
update `delivered.md` per phase PR; update `backlog.md` with the
named-not-built items from target §9.

**Sequenced steps.**

---

#### S-28: docs: comprehensive doc sweep + four ADRs + plan move + delivered + backlog

| Attribute | Detail |
|---|---|
| **Phase** | 8 — Documentation |
| **Frontend area** | Documentation |
| **Target sections** | All — docs codify the implemented state. |

**Files touched:**

- `docs/architecture.md` — **refactor** add a "Frontend Architecture"
  section covering: three-layer state separation, eight bounded
  contexts mirrored 1:1 with backend, view composition layer,
  hexagonal frontend ports, SSE realtime contract, projection-typed
  Operations hooks, invalidation router as single contract surface,
  query-key registry, `tenant`-first keys, route-level Zod search
  schemas, file-based router with auto-codesplitting, TanStack
  Query / Router / Table / Form, shadcn/ui + Tailwind, Vitest +
  RTL + MSW + Playwright + Storybook + axe-core. Add a Mermaid
  diagram of the provider stack and one of the SSE → invalidation
  router → cache flow.
- `docs/decisions.md` — **refactor** add four ADRs (each dated to
  the Phase 8 PR merge):
  1. **"TanStack Family Adopted For The Frontend"** — TanStack
     Router (file-based via Vite plugin), TanStack Query v5,
     TanStack Table v8, TanStack Form. Cites `frontend-target.md`
     §4.1 / §4.3 / §4.5 / §4.6.
  2. **"Frontend Hexagonal Ports With Local + Hosted Adapters
     Named"** — `ApiClientPort`, `EventStreamPort`, `StoragePort`,
     `SessionPort`, `ClipboardPort`, `OpenInOsPort`,
     `TelemetryPort`, `FeatureFlagPort`. Cites `frontend-target.md`
     §6 + §9.
  3. **"SSE Realtime Via `GET /v1/events/stream` + Invalidation
     Router"** — backend endpoint contract + frontend pure-function
     router + `setQueryData` for high-frequency events. Cites
     `frontend-target.md` §7.
  4. **"View-vs-Context Dichotomy + 1:1 Backend Bounded-Context
     Mirror"** — eight `contexts/` folders, three `views/`
     composers, no view-to-view imports, no context-to-view
     imports. Cites `frontend-target.md` §3.10 + §11.
- `docs/local-development.md` — **refactor** add `pnpm web:storybook`,
  `pnpm web:test`, `pnpm web:e2e`, `pnpm web:test-d`,
  `pnpm web:lint` to the verify section.
- `docs/local-ts-api.md` — **refactor** document `GET /v1/events/stream`
  per target §7.1 (already done in S-19, but ensure complete).
- `docs/local-reliability-qa.md` — **refactor** add the two new
  parity-test rows ("Every backend DomainEvent has a registered
  invalidation handler" → `every-event-has-handler.test.ts`;
  "Every STAGE_STATE_KINDS value has a `<StageBadge>` arm" →
  `every-stage-state-has-badge.test.ts`); add one row per
  Playwright critical flow.
- `AGENTS.md` — **refactor** add the frontend reference docs to the
  "Reference Index"; add the new verification commands to the
  "Build, Test, And Lint Commands" section; add a row to the
  "Documentation Requirements" table for `frontend-target.md`
  ("Frontend architecture (state layers, bounded contexts, ports,
  realtime, testing pyramid)").
- `docs/INDEX.md` — **refactor** add `frontend-target.md` to the
  index.
- `docs/delivered.md` — **refactor** add one row per Phase 1..7 PR
  with PR number (filled at landing).
- `docs/backlog.md` — **refactor** add target §9 named-not-built
  items, each with its fitness function:
  - SSR / TanStack Start (§9.1).
  - RSC under TanStack Start (§9.2).
  - `JwtSessionAdapter` for hosted auth (§9.3).
  - Tenant-scoped routing `/t/$tenantId/*` (§9.4).
  - `OpenTelemetryWebAdapter` audit-log streaming (§9.5).
  - CDN-cached projection reads (§9.6).
  - IndexedDB persistence (§9.7).
  - `WebSocketEventStreamAdapter` (§9.8).
  - Visual regression (Chromatic / Loki).
  - `ImportJobUseCase`, `useEnrichmentRetryMutation`,
    `useCorrectScoreMutation` placeholders awaiting backend
    endpoints.
- `docs/plans/proposed/frontend-tanstack-migration.md` — **deleted**
  (moved).
- `docs/plans/implemented/<merge-date>-frontend-tanstack-migration.md`
  — **new** (this file, moved from `proposed/`).

**Approach.** Documentation-only PR. No code. The four ADRs are the
canonical record of the architectural decisions encoded in the
implementation; a future maintainer reads `decisions.md` and gets
the four headlines without having to re-derive them from the target
doc.

**Tenancy implications.** None.

**Acceptance:**

- `git diff --check` is clean.
- `docs/INDEX.md` contains `frontend-target.md`.
- `docs/decisions.md` contains the four new ADRs.
- This plan is at `docs/plans/implemented/<merge-date>-frontend-tanstack-migration.md`.

**QA checklist:** doc review.

**Deferred follow-ups:** the named-not-built items in
`docs/backlog.md` each have their fitness function as the trigger
for a future plan.

**Phase 8 Done When (cumulative across step PRs):**

- One step PR landed (S-28).
- All docs reflect the implemented state.

---

## 6. Cross-Cutting Workstreams

### 6.1 Query-Key Convention Rollout

| Phase | What lands |
|---|---|
| Phase 3 (S-12) | Per-context factories: `jobsKeys`, `dashboardKeys`, `artifactsKeys`, `applyRunsKeys`, `healthKeys`, `profileKeys`. Tenant-first prefix from day one. Registry at `contexts/operations/queryKeys.ts`. |
| Phase 5 (S-20) | Invalidation router consumes the registry; every event handler returns query-key tuples produced by these factories. |
| Phase 6 (S-22) | Unit tests assert structural equality of generated keys for representative inputs. |

### 6.2 Hook Convention Rollout

| Phase | What lands |
|---|---|
| Phase 3 (S-13) | Operations read hooks per target §4.4.1 — `useDashboardSummaryQuery`, `useJobsListQuery`, `useJobDetailQuery`, `useArtifactsListQuery`, `useArtifactDetailQuery`, `useApplyRunsListQuery`, `useApplyRunQuery`, `useHealthQuery`. |
| Phase 3 (S-14) | Per-aggregate mutation hooks per target §4.4.2/.4/.6/.7/.8 — Discovery, Profile, Materials, Apply, Pipeline (plus Scoring + Enrichment placeholders per §3.5/§3.3). |
| Phase 4 (S-18) | Resume Import wizard hooks. |
| Phase 6 (S-23, S-24) | Hook tests with MSW; `tsd` type tests for inferred shapes. |

### 6.3 EventStream / Invalidation Router Rollout

| Phase | What lands |
|---|---|
| Phase 1 (S-04) | `EventStreamPort` interface + stub adapter (`status: "stub"`). |
| Phase 3 (S-16) | `EventStreamProvider` mounted; invalidation router scaffolded with empty handler map (compile-time `Record<DomainEvent["type"], InvalidationHandler>` typing); per-context `handlers.ts` files with placeholder bodies. |
| Phase 5 (S-19) | `GET /v1/events/stream` endpoint shipped on `apps/api/`. |
| Phase 5 (S-20) | Real `SseEventStreamAdapter` replaces the stub; handler bodies populated per target §8.4; `setQueryData` path for `ApplyRunEventRecorded`; 30s "connection lost" banner; one-shot full `invalidateQueries()` backstop on reconnect. |
| Phase 6 (S-22) | Per-event invalidation-router unit tests; the `every-event-has-handler.test.ts` parity test. |

### 6.4 View Composition Pattern Rollout

| Phase | What lands |
|---|---|
| Phase 2 (S-09) | Three view folders (`views/dashboard/`, `views/jobs/`, `views/artifacts/`) populated with extracted view bodies. View → context one-way direction enforced by `dependency-cruiser` config landed in S-15. |
| Phase 3 (S-15) | View files consume hooks; ESLint `no-restricted-imports` forbids `@jobhunter/api-client` and `@jobhunter/contracts` outside the ACL. |
| Phase 4 (S-17) | Cell renderers from `contexts/<aggregate>/components/` composed into `JobsTable` / `ArtifactsTable`. |

### 6.5 Test File Naming + Location Convention

- Unit tests: co-located `*.test.ts` / `*.test.tsx`.
- Type tests: co-located `*.test-d.ts` (run by `tsd`).
- A11y tests: co-located `*.a11y.test.tsx`.
- Storybook stories: co-located `*.stories.tsx`.
- E2E: under `apps/web/e2e/tests/<flow>.spec.ts`.
- MSW handlers: `apps/web/src/test/msw/handlers.ts` (single file per
  backend route surface).
- Fixtures: `apps/web/src/test/fixtures/<concept>.ts`.

| Phase | What lands |
|---|---|
| Phase 6 (S-22) | Convention enforced by Vitest config glob + ESLint rules. |

### 6.6 Storybook Stories Convention

- Co-located `<Component>.stories.tsx`.
- Stories accept the MSW addon for data-driven story states.
- Per-state stories (loading / populated / empty / error) for
  data-driven views; per-variant stories for primitives;
  per-discriminant-arm stories for components rendering
  discriminated unions (`<StageBadge>` per `STAGE_STATE_KINDS`).

| Phase | What lands |
|---|---|
| Phase 7 (S-26, S-27) | Convention rollout. |

### 6.7 Tailwind / Design-Token Convention

- `tailwind.config.ts` consumes design tokens from `tokens.css`.
- `darkMode: ["selector", "[data-theme='dark']"]` per target §4.8.
- Utility-first; no CSS-in-JS runtime.
- Design tokens (color values, spacing scale, font scale) ship as
  placeholders; design owns the values per target §1 Non-Goals.

| Phase | What lands |
|---|---|
| Phase 1 (S-01) | `tailwind.config.ts`, `tokens.css`, `globals.css`. |

### 6.8 ADR Drafts (codified in S-28)

1. **TanStack Family Adopted For The Frontend** (target §4.1, §4.3, §4.5, §4.6).
2. **Frontend Hexagonal Ports With Local + Hosted Adapters Named** (target §6, §9).
3. **SSE Realtime Via `GET /v1/events/stream` + Invalidation Router** (target §7).
4. **View-vs-Context Dichotomy + 1:1 Backend Bounded-Context Mirror** (target §3.10, §11).

### 6.9 MEMORY / CLAUDE.md Updates

This plan does **not** introduce new auto-memory entries. The
existing `feedback_no_strangler.md` already governs the
rip-and-replace discipline used throughout. If a new
architectural-discipline finding emerges during the migration
(e.g., "all per-context handler files must be registered by name in
the invalidation router for grep-ability"), capture it as a
follow-up note; do not amend memory inline.

---

## 7. Out-of-Scope (Deferred)

Each item below is explicitly deferred. Cite the target evolution
path / fitness function (target §9) where applicable.

| Deferred item | Target section | Evolution trigger / fitness function |
|---|---|---|
| **TanStack Start (SSR)** — Vite SPA stays. | §9.1 | p50 cold TTI > 1s on Fast 3G OR shareable public URLs needed OR SEO becomes a goal. |
| **RSC under TanStack Start** — all client components. | §9.2 | gzipped bundle > 500 KB on the largest route AND Start RSC stable. |
| **`JwtSessionAdapter` (Auth0/Cognito)** — `LocalSessionAdapter` returns `LOCAL_TENANT`. | §9.3 | API exposed beyond `127.0.0.1`. |
| **Tenant-scoped routing `/t/$tenantId/*`** — query keys already tenant-prefixed; URL prefix waits. | §9.4 | A single user belongs to > 1 tenant. |
| **`OpenTelemetryWebAdapter` audit-log streaming** — `ConsoleTelemetryAdapter` no-ops. | §9.5 | SOC2 / GDPR access-log requirement. |
| **CDN-cached projection reads** — local hits 127.0.0.1; cache headers irrelevant. | §9.6 | Dashboard / jobs-list median p50 > 200ms from client. |
| **IndexedDB persistence (`@tanstack/query-sync-storage-persister`)** — in-memory cache. | §9.7 | Avg session > 5 min AND cold p95 TTI > 800 ms (both required). |
| **`WebSocketEventStreamAdapter`** — SSE only. | §9.8 | SSE proves to drop behind reverse proxies / CDNs OR duplex required. |
| **Web Push notifications (`NotificationsPort`)** — not in scope. | §7.9 | Tab-closed apply completion notifications become a feature requirement. |
| **Per-resource SSE subscriptions** (`subscribe(resource: "job", id)`) | §7.9 | Event volume so high that per-tenant filtering is insufficient. |
| **`useImportJobMutation`** (Discovery: manual job add) | §3.2 | `ImportJobUseCase` exposed in the API. |
| **`useEnrichmentRetryMutation`** | §3.3 | `EnrichJobUseCase` exposed as a manual trigger in the API. |
| **`useCorrectScoreMutation`** | §3.5 | `CorrectScoreUseCase` exposed in the API. |
| **Visual regression** (Chromatic / Loki) | §10.5 | Design changes start producing un-noticed regressions; or design opts in. |
| **Broader a11y audit** (beyond axe critical violations on forms / dialogs) | §1 Non-Goals | Dedicated phase; this plan covers the named "no critical violations" bar only. |
| **i18n** | §1 Non-Goals | Multi-locale becomes a product requirement. |
| **Native (Tauri / Electron) wrapper** | §1 Non-Goals | Port discipline keeps it unblocked; no work needed today. |
| **Performance budgets in CI** (bundle-size ratchet, Lighthouse) | §1 Non-Goals | Target R10 mitigation — the migration plan's QA gates assert success but do not ratchet bundle size. The ratchet lands when bundle size becomes a regression risk. |
| **Visual design tokens / final color palette / typography** | §1 Non-Goals | Design owns the values; `tokens.css` ships placeholders. |
| **Command Palette UI** (`cmd-k`) | §13 (CommandPalette glossary) | Store seam exists; UI lands when needed. |
| **`JobId` migration in `apps/api`** (URL → stable ID) | §6.5 R13 | Backend rename; frontend ACL is the single mapping site. |

---

## 8. QA & Reliability Gates

Per-phase gates beyond `pnpm web:check && pnpm web:build &&
pnpm web:lint && pnpm test` (which every phase must pass):

### Phase 0: Pre-flight

- §3 checklist all green.

### Phase 1: Foundation

- **Add to QA matrix:** "Theme persists across refresh; no flash on
  cold load" → manual.
- **Verification:** `pnpm web:check && pnpm web:build && pnpm web:dev`;
  manual matrix from `docs/local-reliability-qa.md`.

### Phase 2: Router

- **Add to QA matrix:** "Refresh stays on the current view";
  "Deep link `/jobs/$jobId` opens drawer with table preserved";
  "Wizard steps survive refresh"; "No `jobhunter:set-jobs-filter`
  custom event in any code path"; CI grep guards from §2 principle 3.
- **Verification:** above + manual matrix.

### Phase 3: Query

- **Add to QA matrix:** "All previous loads use TanStack Query";
  "Mutation success refreshes dependent views"; "API failure
  triggers global error toast"; CI grep guards (no `useRef(0)`,
  no direct `@jobhunter/api-client` import outside the ACL).
- **Verification:** above + ESLint rule pass + React Query Devtools
  shows tenant-scoped keys.

### Phase 4: Table + Form

- **Add to QA matrix:** "Sort / select-page / select-all / pagination
  behave equivalently"; "Profile / Settings / Credentials forms
  validate via Zod"; CI grep guards (no per-field `useState<...Draft...>`).
- **Verification:** above + manual matrix.

### Phase 5: Realtime

- **Add to QA matrix:**
  - "SSE endpoint responds with `Content-Type: text/event-stream`."
  - "Triggering apply updates dashboard within ≤ 1s without refresh."
  - "Killing API → connection-status pill shows `reconnecting`
    within ≤ 30s."
  - "Reconnect triggers full cache invalidation backstop."
  - "Apply-run timeline appends events via `setQueryData` (not
    refetch)."
- **Verification:** above + `pnpm api:test` covers the SSE endpoint
  unit test; manual SSE flow.

### Phase 6: Testing harness

- **Add to QA matrix:**
  - "`every-event-has-handler.test.ts` fails CI on stub handlers."
  - "`every-stage-state-has-badge.test.ts` fails CI on missing arms."
  - "`pnpm web:test` covers ≥ 70% of `contexts/` and `views/`."
  - "`pnpm web:e2e` runs eight critical flows headless."
- **Verification:** `pnpm web:test && pnpm web:test-d && pnpm web:e2e`.

### Phase 7: Storybook + a11y

- **Add to QA matrix:**
  - "`pnpm web:storybook:build` succeeds in CI."
  - "Form / dialog stories pass axe critical-violations bar."
- **Verification:** `pnpm web:storybook:build &&
  pnpm web:storybook:test`.

### Phase 8: Documentation

- **Add to QA matrix:** "`docs/INDEX.md` lists every doc." (already
  satisfied; the addition is `frontend-target.md`.)
- **Verification:** `git diff --check`; doc review.

---

## 9. Documentation Plan

| Phase | Step | Docs updated | What changes |
|---|---|---|---|
| 1 | S-01 | `docs/local-development.md` | Note `pnpm web:check` enables strict TS options. |
| 1 | S-06 | None | Internal refactor (foundation files). |
| 2 | S-09 | `docs/local-ts-api.md` (light) | Note that the web app now uses URL-bound state for filters / sort / pagination / drawer-open. |
| 3 | S-15 | `docs/architecture.md` (light) | Note that `apps/web/src/contexts/` mirrors backend bounded contexts; `views/` are composers. |
| 5 | S-19 | `docs/local-ts-api.md` | Document `GET /v1/events/stream` endpoint + contract per target §7.1. |
| 6 | S-22..S-25 | `docs/local-reliability-qa.md` | Add per-phase QA matrix rows; add the two parity-test rows. |
| 7 | S-26..S-27 | None mid-phase. | Storybook is a dev tool; doc lands in S-28 sweep. |
| 8 | S-28 | All — `architecture.md`, `decisions.md`, `local-development.md`, `local-ts-api.md`, `local-reliability-qa.md`, `AGENTS.md`, `INDEX.md`, `delivered.md`, `backlog.md`. | Final sweep; four new ADRs; plan moved to `implemented/`. |

**New ADR entries** (in `docs/decisions.md`, dated to Phase 8 PR
merge):

1. **"TanStack Family Adopted For The Frontend"** — date of S-28
   merge.
2. **"Frontend Hexagonal Ports With Local + Hosted Adapters
   Named"** — date of S-28 merge.
3. **"SSE Realtime Via `GET /v1/events/stream` + Invalidation
   Router"** — date of S-28 merge.
4. **"View-vs-Context Dichotomy + 1:1 Backend Bounded-Context
   Mirror"** — date of S-28 merge.

**Superseded decisions:**

- "React With Vite For The Frontend" (2026-05-02) is **advanced,
  not superseded** — Vite stays; TanStack Router (file-based via
  Vite plugin) and TanStack Query are layered on top.
- "Loopback API Binding By Default" (2026-05-02) is **unchanged**
  — `GET /v1/events/stream` honors the same loopback binding.
- "Stage State Is The Operational Source Of Truth" (2026-05-02)
  is **advanced, not superseded** — the frontend's `<StageBadge>`
  exhaustive `switch` and the parity test enforce it visually.
- "Copyable Commands Stay, Buttons Use Structured Actions"
  (2026-05-03) is **preserved verbatim** — `<CopyableCommand>` in
  `shared/ui/` is the named primitive.

---

## 10. Branching Convention

Per AGENTS.md and §2 principle 1, every step lands as its own PR on
its own worktree on its own branch. Cut-over steps (S-06, S-09,
S-15, S-17, S-18, S-20) carry the rip-and-replace deletion in the
same PR that ships the new construct. Preparation steps (everything
else) ship the new construct alone — the legacy code path is
untouched until the next cut-over step lands.

- **Branch naming:** `web/s-<NN>-<short-name>` (e.g., `web/s-01-tailwind-tokens`,
  `web/s-09-router-view-split`, `web/s-15-views-to-hooks`).
- **PR titles** follow conventional commits with the step ID:
  - `chore(web): S-01 — pin dependency baseline + tailwind 4 + tokens + globals`
  - `feat(web): S-02 — copy shadcn/ui primitives + lucide-react`
  - `feat(web): S-03 — zustand stores + shared hooks`
  - `feat(web): S-04 — ports + local adapters (api, eventstream stub, storage, session, clipboard, openinos, telemetry, featureflag)`
  - `feat(web): S-05 — provider stack (ports, tenant, theme, density, toaster)`
  - `feat(web): S-06 — appshell + topbar + navbar; delete legacy header + inline theme useState` *(cut-over)*
  - `chore(web): S-07 — install tanstack router + vite plugin + tsr.config`
  - `feat(web): S-08 — scaffold route tree (__root + dashboard + jobs + artifacts + profile + settings + 404)`
  - `feat(web): S-09 — per-route view split; delete useState<View> + monolithic App.tsx + window.dispatchEvent` *(cut-over)*
  - `chore(web): S-10 — install tanstack query v5; mount queryclientprovider; configure defaults + global error toast`
  - `feat(web): S-11 — bind apiclientport + operations/types.ts ACL re-exports`
  - `feat(web): S-12 — per-context query-key factories + querykeys registry`
  - `feat(web): S-13 — operations read hooks (dashboard, jobs, artifacts, applyruns, profile pdf preview, health)`
  - `feat(web): S-14 — per-aggregate mutation hooks + placeholders (createoptimisticmutation helper, exhaustive helper)`
  - `refactor(web): S-15 — rewire views to hooks; delete useState/useEffect/useRef-requestSeq + sibling-loader callbacks + URL-state useState` *(cut-over)*
  - `feat(web): S-16 — eventstreamprovider scaffold + invalidation router skeleton`
  - `feat(web): S-17 — jobstable + artifactstable on tanstack table v8 + per-context cell renderers; delete hand-rolled sort/select/pagination JSX` *(cut-over)*
  - `feat(web): S-18 — tanstack form for profile + settings + credentials + wizard step forms; delete per-field useState draft trees` *(cut-over)*
  - `feat(api): S-19 — add GET /v1/events/stream endpoint (json_extract tenant filter + index)`
  - `feat(web): S-20 — real sseEventStreamAdapter + populated invalidation router + connection banner; delete phase-1 stub` *(cut-over)*
  - `chore(web): S-21 — install vitest + rtl + msw + jsdom; ship msw handlers + fixtures + setup`
  - `feat(web): S-22 — unit tests for query-key factories + invalidation router + parity tests + selectors + zod schemas`
  - `feat(web): S-23 — hook tests with msw + component tests + sse integration test`
  - `chore(web): S-24 — add playwright + per-test isolated sqlite + 8 critical flows`
  - `feat(web): S-25 — tsd type tests + axe-core for form/dialog components`
  - `chore(web): S-26 — install storybook + addons; ship per-shared/ui stories`
  - `feat(web): S-27 — per-context domain stories + view stories + a11y addon enforcement`
  - `docs(web): S-28 — comprehensive doc sweep + four ADRs + plan move + delivered + backlog`

- **Stacked PRs.** Steps within a phase stack on each other (S-10 →
  S-11 → S-12 → ...); steps across phases stack on the previous
  phase's last merged step. Cut-over steps cannot land before all
  their preparation steps (the cut-over PR's diff would not compile
  otherwise).

- **Squash-and-merge.** Each PR squashes to one commit at landing
  time. The phase's PRs collectively form a coherent narrative in
  `git log` (one commit per step, not one commit per phase). The
  AGENTS.md "small reviewable PRs" rule is respected.

**Why per-step PRs with cut-over markers, not per-phase PRs
(rationale):** preparation steps ship new code with no live
consumer — the app builds because nothing references the new code.
That is not strangler discipline (strangler is "wrap the old
behavior to be replaced gradually"); it is "ship infrastructure,
then in one cut-over PR rewire and delete." The cut-over PR is the
only one that touches both old and new code; it ships the rewire
and the deletion in the same diff per `feedback_no_strangler.md`.
This mirrors the DDD migration plan's per-step cadence (e.g., DDD
S-13 introduces the Profile aggregate; DDD S-14 is the cut-over
that rewires consumers and deletes `config.load_profile()`).

**Why not finer-grained per-file/per-component PRs:** the cut-over
steps (S-09, S-15, S-17, S-18) each touch many files in a single
coherent change. Splitting them per-file would either re-introduce
strangler discipline (one file ships hooks while another file still
uses the legacy fetch) or produce mid-cut-over commits that don't
build. Cut-over steps are the *minimum* atomic unit per the
no-strangler discipline.

---

## 11. Glossary Diff

**Terms introduced by this plan into the glossary** (extending
`docs/frontend-target.md` §13):

| Term | Definition |
|---|---|
| **Cut-Over Step** | A step whose PR rewires consumers to a new construct AND deletes the legacy code path in the same diff. The minimum atomic unit per `feedback_no_strangler.md`. Cut-over steps in this plan: S-06, S-09, S-15, S-17, S-18, S-20. |
| **Preparation Step** | A step whose PR ships a new construct that no live consumer references yet. Not strangler discipline — the legacy code path is untouched. Every step that is not a cut-over step is a preparation step (S-01..S-05, S-07, S-08, S-10..S-14, S-16, S-19, S-21..S-28). |
| **Step ID** | An `S-NN` identifier scoping an intra-phase review unit. Steps do not produce separate commits at landing; they organize the phase PR for review. |
| **Phase Done Gate** | The cumulative gate after all step PRs in a phase have landed: every step PR green; build / typecheck / lint / unit / e2e / manual matrix all pass on the post-cut-over branch state; CI grep guards pass. Replaces the v1 "Phase Squash Gate" concept; the per-phase squash idea is dropped per §2 + §10 in favor of per-step PRs. |
| **CI Grep Guard** | A grep-based CI step that fails the build if a forbidden pattern reappears. Examples: `useState<View>`, `jobhunter:set-jobs-filter`, `dispatchEvent(new CustomEvent`, `useRef(0)` in views/contexts, `from "@jobhunter/api-client"` in views/contexts. Each guard is added in the phase that deletes the pattern. |
| **Placeholder Hook** | A mutation hook shipped as a file with a `NotImplementedError`-throwing body, gated behind `FeatureFlagPort`. Used for `useImportJobMutation`, `useEnrichmentRetryMutation`, `useCorrectScoreMutation` per target §3.2 / §3.3 / §3.5 — gives the context folder its target-specified shape without preempting backend work. |
| **Per-Context handlers.ts** | A file under `apps/web/src/contexts/<name>/handlers.ts` exporting the invalidation handler functions for that context's events; imported by `contexts/operations/invalidation-router.ts` (the central router). Co-locates handlers with the context that owns the events while keeping registration centralized per target §11. |
| **Step Stack** | The cross-phase PR stack: each step PR rebases on the previous step's main after merge. S-01 → S-02 → ... → S-20 form the linear stack; S-21..S-25 (Phase 6) and S-26..S-27 (Phase 7) and S-28 (Phase 8) can stack within their phases independently of each other after Phase 5 lands. |
| **Squash-and-merge** | The GitHub merge mode used per step PR — produces one commit per step (not per phase). The phase's PRs collectively form a coherent narrative in `git log` (one commit per step). Per §10. |
| **`createOptimisticMutation` helper** | Shared `apps/web/src/shared/lib/createOptimisticMutation.ts` encoding the snapshot → patch → rollback → invalidate sequence. Mutation hooks supply only the patcher and key set. Per target R2. |
| **`appendApplyRunEvent` selector** | Pure helper at `apps/web/src/contexts/apply/selectors/applyRunSelectors.ts` used by the invalidation router's `setQueryData` path for `ApplyRunEventRecorded` per target §7.4. |

**Renaming from current code:**

| Current name | Target name | Phase / Step |
|---|---|---|
| `useState<View>("dashboard")` view switcher | TanStack Router file-based routes + `<Outlet />` | Phase 2 (S-09) |
| `useState<DataShape \| null>(null)` + `useEffect(load)` + `useRef(0)` requestSeq | `useXxxQuery(input)` from `contexts/operations/hooks/` | Phase 3 (S-15) |
| `await Promise.all([load(), onJobsChanged()])` sibling reloads | `queryClient.invalidateQueries(<key>)` from each mutation hook | Phase 3 (S-14, S-15) |
| `window.dispatchEvent(new CustomEvent("jobhunter:set-jobs-filter", ...))` | `navigate({ to: "/jobs", search: { state: "..." } })` | Phase 2 (S-09) |
| Per-field `useState<DraftValue>(initial)` with manual diff | TanStack Form `useForm({ defaultValues, validators: { onSubmit: ZodSchema } })` | Phase 4 (S-18) |
| `localStorage.getItem("jobhunter-theme")` + `useState<Theme>` + `useEffect` writeback | `useUiPreferencesStore` (Zustand+persist, key `jh:theme`) + `useTheme()` selector | Phase 1 (S-03, S-06) |
| Hand-rolled `<button onClick={() => changeSort(...)}>` table headers + manual pagination JSX | `useReactTable({ ..., manualSorting, manualPagination, onSortingChange, ... })` (TanStack Table v8) | Phase 4 (S-17) |
| Inline JSX `{view === "dashboard" ? <Dashboard /> : ...}` ladder | TanStack Router `<Outlet />` resolved from `routeTree.gen.ts` | Phase 2 (S-08, S-09) |
| Direct `import { createJobHunterApiClient } from "@jobhunter/api-client"` in views | `usePorts().api.<method>` via the `FetchApiClientAdapter` behind `ApiClientPort` | Phase 3 (S-11, S-15) |
| Direct `import { ... } from "@jobhunter/contracts"` for projection types in views/contexts | `import { ... } from "../../contexts/operations/types"` (frontend ACL) | Phase 3 (S-11) |
| No realtime; `loads once on mount; refresh requires a page reload` | `<EventStreamProvider>` + SSE + invalidation router | Phase 5 (S-19, S-20) |
| `apps/web/src/styles.css` (CSS-variable-driven theming) | `apps/web/src/styles/{tokens.css, globals.css}` + Tailwind utilities | Phase 1 (S-01) |
| Zero tests | Vitest + RTL + MSW + Playwright + tsd + axe-core; two parity tests | Phase 6 (S-21..S-25) |
| Zero stories | Storybook + addon-a11y + addon-msw; per-primitive + per-context + per-view stories | Phase 7 (S-26, S-27) |

---

## 12. Risks (Plan-Level Mitigations for `frontend-target.md` §12 R1–R14)

The target doc enumerates 14 risks (R1–R14) and their architectural
mitigations. This section maps each to the **migration step that
implements the mitigation** so a reviewer of any phase PR can verify
the risk is being addressed.

| Risk (target §12) | Mitigation step(s) | Notes |
|---|---|---|
| **R1 — Cache-invalidation correctness (router as single point of failure)** | S-16 (router scaffold with compile-time `Record<DomainEvent["type"], InvalidationHandler>` typing); S-20 (handlers populated); S-22 (per-event unit tests + `every-event-has-handler.test.ts` parity test). | Compile-time typing is the primary guard; parity test is the runtime backstop per target §7.4. |
| **R2 — Optimistic-update rollback bugs** | S-14 (`createOptimisticMutation` helper encodes snapshot → patch → rollback → invalidate); S-22 (helper unit test); S-23 (per-mutation hook tests assert rollback). | Helper is a pure function; mutation hooks supply only the patcher and key set. |
| **R3 — SSE delivery gaps under reverse-proxy / CDN buffering** | S-19 (server sets `X-Accel-Buffering: no` + 30s heartbeat); S-20 (frontend 30s "connection lost" banner + one-shot full-cache invalidation backstop on reconnect). | Heartbeat + reconnect backstop together cover proxy buffering. |
| **R4 — Route-loader prefetch racing with mutations** | S-13 (loaders use `ensureQueryData`, not `fetchQuery`); S-14 (mutations declare `meta.affectsRoutes` consumed by a small middleware that calls `router.invalidate()` for affected routes). | `ensureQueryData` honors stale state and triggers background refetch. |
| **R5 — `exactOptionalPropertyTypes` adoption surfaces latent bugs** | S-01 (strict TS enabled in the same step that adds Tailwind; compile errors fixed in-place; no `// @ts-expect-error`). | No parallel old/new strict path per `feedback_no_strangler.md`. |
| **R6 — `window.dispatchEvent` deletion regression risk** | S-09 (deletes every `dispatchEvent("jobhunter:set-jobs-filter", ...)` site; replaces with `navigate({ search: ... })`); S-15 (CI grep guard `! grep -rE 'dispatchEvent\(new CustomEvent' apps/web/src` + ESLint `no-restricted-syntax` rule); S-25 (Playwright smoke flow exercises the dashboard-KPI → jobs-filter-prefill flow). | Three-layer enforcement: code deletion, CI grep, ESLint, E2E. |
| **R7 — Drift between `@jobhunter/domain-types` Zod schemas and SSE payloads** | S-20 (frontend parses with strict Zod; unknown fields rejected; unknown event-type logged via `usePorts().telemetry.error(...)` and dropped). | `scripts/check-domain-type-parity.py` already enforces TS↔Python parity at the type level. |
| **R8 — View-vs-context boundary erosion** | S-15 ships a `dependency-cruiser` config (`apps/web/.dependency-cruiser.cjs`) with three forbidden rules: `no-context-to-view` (severity `error`), `no-view-to-view` (severity `error`), `no-view-to-context-internals` (severity `warn`, opt-out via comment). CI runs `pnpm web:depcruise` alongside `pnpm web:lint`. CODEOWNERS routes `contexts/` and `views/` to the same reviewer (S-28 AGENTS.md update). | dependency-cruiser is the right tool for cross-folder import rules; ESLint's `no-restricted-imports` is per-file and cannot express "from X import Y." |
| **R9 — Aggressive `staleTime` defaults masking SSE-router bugs** | S-10 (dashboard `staleTime: 0`); S-20 (`<ConnectionStatusPill>` makes degraded SSE visible); S-22 (router parity test prevents the silent-failure mode). | Visible degraded-SSE state + parity test together cover the silent-failure case. |
| **R10 — Bundle-size growth as features compound** | S-07 (Vite plugin `autoCodeSplitting: true` for free per-route chunks); deferred to §7 Out-of-Scope is the bundle-size CI ratchet (out-of-scope per target §1 Non-Goals — performance budgets live in QA gates of a future plan). | Per-route splitting is the structural mitigation; ratchet is deferred. |
| **R11 — Wizard-store persistence corruption** | S-03 (Zustand `persist` middleware with `version` field; migration function discards on schema change); S-09 (wizard upload step clears stale store on entry); the store's read path narrows the parsed shape with Zod. | Discard-on-version-change is the no-strangler-discipline answer for a single-user wizard. |
| **R12 — JSON-RPC `runId` correlation gaps (SSE arrives before mutation resolves)** | S-14 (mutations write the optimistic "in-flight" cache entry in `onMutate`, *before* the network call; `runId` is included in the request payload as idempotency key and echoed in events; the frontend correlates by `runId`, not request-response timing). | Applies symmetrically to Materials AND Apply per minor finding. |
| **R13 — `JobId` migration window — `apps/api` still accepts `jobKey: string`** | S-11 (frontend ACL at `contexts/operations/types.ts` is the single mapping site; `JobId` is brand-typed; `apiClient.deleteJob(jobId, ...)` passes the `JobId` value as the API's currently-named `jobKey` parameter). | When the backend rename lands, only the ACL changes; every call site is already on `jobId: JobId`. |
| **R14 — Materials-set generation invalidation under concurrent re-tailoring** | S-14 (the optimistic patcher records `runId` in the cache entry; the SSE handler matches by `runId` before applying; `<GenerateMaterialsButton>` is `disabled` while in-flight via a `useIsMaterialsRunInFlight(jobId)` selector); S-23 (mutation tests assert correct `runId` correlation). | Same `runId`-keyed pattern applies to all async (202) mutations including Apply (per minor finding). |

---

## 13. Step Index

For convenience, the full step list:

| Step | Phase | Title |
|---|---|---|
| S-01 | 1 | chore(web): pin dependency baseline + add Tailwind 4 + tokens + globals |
| S-02 | 1 | feat(web): copy shadcn/ui primitives + lucide-react icons |
| S-03 | 1 | feat(web): add Zustand stores + shared hooks |
| S-04 | 1 | feat(web): define ports + local adapters |
| S-05 | 1 | feat(web): mount provider stack |
| S-06 | 1 | feat(web): introduce AppShell + Topbar + NavBar + ThemeToggle + ConnectionStatusPill |
| S-07 | 2 | chore(web): install TanStack Router + Vite plugin + configure route generation |
| S-08 | 2 | feat(web): scaffold route tree |
| S-09 | 2 | feat(web): split App.tsx into per-view files; mount RouterProvider; delete useState<View>; delete window.dispatchEvent coordination |
| S-10 | 3 | chore(web): install TanStack Query v5; mount QueryClientProvider; configure defaults + global error toast |
| S-11 | 3 | feat(web): bind ApiClientPort + define operations/types.ts ACL re-exports |
| S-12 | 3 | feat(web): per-context query-key factories + queryKeys registry |
| S-13 | 3 | feat(web): Operations read hooks |
| S-14 | 3 | feat(web): per-aggregate mutation hooks + placeholders |
| S-15 | 3 | refactor(web): rewire every view to hooks; delete useState/useEffect/useRef-requestSeq + sibling-loader callbacks; URL-bind every filter |
| S-16 | 3 | feat(web): EventStreamProvider scaffold + invalidation router skeleton |
| S-17 | 4 | feat(web): JobsTable + ArtifactsTable on TanStack Table v8 + per-context cell renderers |
| S-18 | 4 | feat(web): TanStack Form for Profile + Settings + Credentials + Resume Import wizard steps |
| S-19 | 5 | feat(api): add GET /v1/events/stream endpoint per frontend-target.md §7.1 |
| S-20 | 5 | feat(web): real SseEventStreamAdapter + populated invalidation router + connection banner |
| S-21 | 6 | chore(web): install Vitest + RTL + MSW + jsdom; ship MSW handlers + fixtures + setup; CI integration |
| S-22 | 6 | feat(web): unit tests for query-key factories + invalidation router + parity tests + selectors + Zod schemas |
| S-23 | 6 | feat(web): hook tests with MSW + component tests for filter bar / bulk actions / apply timeline |
| S-24 | 6 | chore(web): add Playwright + per-test isolated SQLite + 8 critical flows |
| S-25 | 6 | feat(web): tsd type tests + axe-core for form/dialog components |
| S-26 | 7 | chore(web): install Storybook + addons; ship per-shared/ui stories |
| S-27 | 7 | feat(web): per-context domain stories + view stories + a11y addon enforcement |
| S-28 | 8 | docs: comprehensive doc sweep + four ADRs + plan move + delivered + backlog |

**Total:** 28 steps across 8 phases (Phase 0 is a gate, no steps).

---

## 14. Cross-Reference: Plan Step → Target Section

Verifies that every phase / step implements something explicitly named
in `docs/frontend-target.md` (target §15 named items not in this plan
appear in §7 Out-of-Scope).

| Target Section | Phase / Step delivering |
|---|---|
| §1 Purpose & Non-Goals | All — purpose statement; non-goals respected throughout. |
| §2.1 Three layers of state | Phase 3 (S-13, S-15: server state); Phase 2 (S-08, S-09: URL state); Phase 1 (S-03, S-05, S-06: client state). |
| §2.2 Bounded-context mirroring | Phase 3 (S-12, S-13, S-14, S-16); Phase 4 (S-17); Phase 5 (S-20). |
| §2.3 Evolutionary architecture | Phase 1 (S-04 — adapters with hosted-mode named); Phase 7 §7 named-not-built; §9 docs. |
| §2.4 Data-orientation | Phase 4 (S-17 `<StageBadge>` exhaustive `switch`); Phase 6 (S-22 stage-state parity test). |
| §2.5 Strict TypeScript | Phase 1 (S-01 enables `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`); Phase 2 (S-08 route-level Zod schemas). |
| §3.1 Frontend Context Map | Phase 3 (S-13, S-14: 8 contexts populated); Phase 2 (S-08, S-09: 3 view composers). |
| §3.2 Discovery (Frontend) | Phase 3 (S-14: delete/restore mutations + placeholder `useImportJobMutation`); Phase 5 (S-20 invalidation handlers). |
| §3.3 Enrichment (Frontend) | Phase 3 (S-14 placeholder `useEnrichmentRetryMutation`, S-16 handlers placeholder); Phase 5 (S-20 handlers). |
| §3.4 Candidate Profile | Phase 2 (S-08, S-09: profile + import + settings routes); Phase 3 (S-13, S-14); Phase 4 (S-18: forms). |
| §3.5 Scoring | Phase 3 (S-14 placeholder `useCorrectScoreMutation`); Phase 4 (S-17 `<ScoreBadge>`, `<ScoreBreakdown>`); Phase 5 (S-20 handlers). |
| §3.6 Materials Generation | Phase 3 (S-14 mutations); Phase 4 (S-17 `<GenerateMaterialsButton>`, `<OpenArtifactButton>`); Phase 5 (S-20). |
| §3.7 Apply Automation | Phase 3 (S-14); Phase 4 (S-17 `<ApplyButton>`, `<ApplyRunBadge>`, `<ApplyRunTimeline>`, `<ApplyHistory>`); Phase 5 (S-20 handlers + `setQueryData`). |
| §3.8 Pipeline Orchestration | Phase 3 (S-14); Phase 4 (S-17 `<StageBadge>`, `<StageTimeline>`, `<JobActions>`, `<RetryStageButton>`, `<CancelStageButton>`, `<MarkAppliedButton>`, `<MarkSkippedButton>`); Phase 5 (S-20 handlers); plus `<CopyableCommand>` (Phase 1 S-02). |
| §3.9 Operations / Read-Side | Phase 3 (S-12 keys, S-13 hooks, S-16 router scaffold); Phase 5 (S-20 router populated). |
| §3.10 Views — composition layer | Phase 2 (S-09); Phase 4 (S-17 composition pattern). |
| §4.1 Query-Key Convention | Phase 3 (S-12); Phase 6 (S-22 unit tests). |
| §4.2 Hook Conventions | Phase 3 (S-13, S-14); Phase 6 (S-23). |
| §4.3 Route Shapes | Phase 2 (S-07, S-08); Phase 3 (S-15 URL binding). |
| §4.4 Per-Context Tactical Spec | Phase 3 (S-13, S-14); Phase 4 (S-17, S-18); Phase 5 (S-20). |
| §4.5 View Composition | Phase 2 (S-09); Phase 4 (S-17). |
| §4.6 Forms Convention | Phase 4 (S-18). |
| §4.7 Component Primitives | Phase 1 (S-02). |
| §4.8 Styling — Tailwind | Phase 1 (S-01). |
| §4.9 Cross-Cutting Client State | Phase 1 (S-03 stores, S-05 providers). |
| §4.10 Theme & Density | Phase 1 (S-03, S-05, S-06). |
| §4.11 Error Handling | Phase 3 (S-10 global QueryCache.onError → toast, route errorComponents); Phase 3 (S-14 per-mutation onError where needed). |
| §5 State Architecture | Phase 1 (S-03, S-05); Phase 2 (S-08, S-09); Phase 3 (S-10..S-16). |
| §5.2 URL ↔ cache binding | Phase 3 (S-13 loaders, S-15 URL-bound hooks). |
| §5.3 Optimistic updates | Phase 3 (S-14 + `createOptimisticMutation` helper). |
| §5.4 Stale time / GC | Phase 3 (S-10, S-13). |
| §6 Hexagonal Boundaries | Phase 1 (S-04 ports, S-05 providers); Phase 5 (S-20 `EventStreamPort` real adapter). |
| §6.5 ACL — `contexts/operations/types.ts` | Phase 3 (S-11). |
| §6.6 No direct DOM access from feature code | Phase 2 (S-09 deletion of `window.dispatchEvent`); enforced by ESLint rule (S-15). |
| §7.1 SSE endpoint | Phase 5 (S-19). |
| §7.2 Typed event schemas | Phase 5 (S-20 `parseDomainEvent`). |
| §7.3 EventStreamProvider | Phase 3 (S-16 scaffold); Phase 5 (S-20 real adapter). |
| §7.4 Invalidation router | Phase 3 (S-16 scaffold); Phase 5 (S-20 populated); Phase 6 (S-22 unit tests + parity test). |
| §7.5 invalidate vs setQueryData | Phase 5 (S-20 `setQueryData` for `ApplyRunEventRecorded`). |
| §7.6 Realtime data flow | Phase 5 (S-19 + S-20). |
| §7.7 Reconnect / backoff / banner | Phase 5 (S-20 `<ConnectionStatusPill>` + banner + full-cache-invalidation backstop). |
| §7.8 Tenant scoping in realtime | Phase 5 (S-19 server validation + S-20 `useEffect(tenantId)` dep). |
| §7.9 What if SSE not enough | §7 Out-of-Scope (`WebSocketEventStreamAdapter`, push notifications). |
| §8 Cross-Context Integration | Phase 5 (S-20 invalidation router); Phase 4 (S-17 composition in JobDetailDrawer). |
| §8.2 Mutation → Invalidation Map | Phase 3 (S-14). |
| §8.3 Hybrid sync/async invalidation | Phase 3 (S-14); Phase 5 (S-20 SSE-driven async). |
| §8.4 Event → Invalidation Map | Phase 5 (S-20). |
| §8.5 Composition patterns | Phase 4 (S-17 `<JobDetailDrawer>` composition). |
| §9 Evolution Paths | §7 Out-of-Scope (every adapter named-not-built); §9 docs (S-28 backlog). |
| §10 Testing Strategy | Phase 6 (S-21..S-25); Phase 7 (S-26..S-27). |
| §10.2 Unit tests + parity tests | Phase 6 (S-22). |
| §10.3 Hook + component tests | Phase 6 (S-23). |
| §10.4 Playwright E2E | Phase 6 (S-24). |
| §10.5 Storybook | Phase 7 (S-26, S-27). |
| §10.6 Type-level tests | Phase 6 (S-25 `tsd`). |
| §10.7 a11y spot-checks | Phase 6 (S-25 `axe-core`); Phase 7 (S-27 addon-a11y). |
| §10.9 CI pipeline | Phase 6 (S-21..S-25 each add CI steps); Phase 7 (S-26, S-27 add Storybook step). |
| §11 Folder Structure | All — every folder lands in its phase. |
| §12 Risks (R1..R14) | Mitigations distributed: R1 (parity tests Phase 6 S-22); R2 (createOptimisticMutation Phase 3 S-14, tests Phase 6); R3 (banner Phase 5 S-20, X-Accel-Buffering Phase 5 S-19); R4 (router.invalidate(), Phase 3 S-15); R5 (strict TS Phase 1 S-01); R6 (CI grep guard Phase 2 S-09 + ESLint Phase 3 S-15); R7 (strict Zod Phase 5 S-20); R8 (ESLint dep direction Phase 3 S-15); R9 (dashboard staleTime: 0 Phase 3 S-10); R10 (per-route splitting Phase 2 S-07; bundle-size budget Out-of-Scope §7); R11 (Zustand persist version Phase 1 S-03); R12 (runId in cache + onMutate Phase 3 S-14); R13 (ACL Phase 3 S-11); R14 (runId-keyed in-flight Phase 3 S-14). |
| §13 Glossary | §11 of this plan adds entries; existing terms preserved verbatim. |
| §14 Open Questions Resolution | Resolved in target itself; this plan implements the resolutions. |
| §15 What this doc does not decide | This plan supplies every "does not decide" item: phase ordering, SSE-endpoint timing, feature ordering, commit messages, branch names, CI step ordering. |

Every section of `docs/frontend-target.md` either has a phase
implementing it or appears in §7 Out-of-Scope with a fitness function.

---
