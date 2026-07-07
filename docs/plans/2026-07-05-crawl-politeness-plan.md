# Crawl Politeness Hardening

> **Status:** proposed — not started. Implementation plan only; no code in this PR.
> **Gate:** this plan is a **pre-public-release gate** for the repository's
> existing outbound fetch paths, and a **hard prerequisite** for any future
> contact-research fetching. Both statements are load-bearing; see §"Gates".
> **Source:** a four-lane read-only inventory of every outbound fetch surface
> (discovery ATS adapters, the `python-jobspy` library, Workday CXS, smart-extract,
> enrichment browser crawling, the LinkedIn apply resolver, compensation feeds,
> the apply browser) plus the existing `SourcePolicy` / source-registry / source-quality
> substrate.
> **Anchors verified against main @ `a488e4e9`** (worktree HEAD at authoring time).
> Line numbers are hints captured at that commit and WILL drift; locate every
> anchor **by symbol name** before editing.
> **Style:** rip-and-replace per the standing directive — each phase that reroutes
> a fetch path deletes the ad-hoc transport/UA it replaces; no compatibility shim,
> no second "legacy" fetch path left alive. This plan **extends** the existing
> fail-closed `SourcePolicy` stance; it never introduces a bypass of a third
> party's technical controls.

---

## Context

The codebase already models source **policy** but does not **enforce** crawl
politeness at the fetch layer, and it has no robots.txt handling at all. The
four inventory lanes confirmed the gap is total across every outbound client.

### What already exists (the substrate this plan builds on)

1. **A fail-closed source policy.** `SourcePolicy`
   (`workers/automation/src/jobctrl/domain/discovery/source_registry.py:104-127`)
   is a frozen value object carrying `allowed_methods`, `authentication`,
   `max_pages_per_run` (default 100), `max_run_frequency` ("PT24H"),
   `locator_max_requests_per_domain` (5), `manual_intervention`, and the
   fail-closed flag `third_party_control_bypass: bool = False`. The invariant is
   enforced in `__post_init__` (`:126-127`) — it cannot be constructed `True`.
   The TS mirror `packages/domain-types/src/discovery/source.ts:86-97` types the
   flag as the literal `readonly thirdPartyControlBypass: false` and re-asserts it
   in `createSourcePolicy` (`source.ts:115-117`). The design record is explicit:
   "If a source cannot be accessed without evasion, JobCtrl should switch to a
   permissioned API, licensed feed, manual import, or user-mediated capture flow."
   (`docs/plans/implemented/2026-05-12-job-search-discovery-rfc.md:462,465-467,936`).
2. **First-class manual-action reasons.** `ManualActionReason`
   (`source_registry.py:60-67`) already includes `RATE_LIMIT`, `BOT_DETECTION`,
   `CAPTCHA`, `PAYWALL`, `LOGIN_REQUIRED`, `PROTECTED_INTERNAL_SITE`. There is
   **no `ROBOTS_DISALLOWED` reason** yet.
3. **An honest user-agent — modelled but not used at the fetch layer.**
   `LocatorPolicy.user_agent = "JobCtrl Source Locator (local)"`
   (`source_registry.py:262-279`) and the compensation feeds' `"JobCtrl/0.3"`
   (`infrastructure/compensation/sqlite_market_repository.py:676,725`) identify
   honestly, and the ATS adapter fetcher (`ats_adapters.py:90-94`) already embeds
   the project repository URL as contact information. But the live crawl paths
   spoof a desktop browser UA (see gap item 3).
4. **A source registry + source-quality read model + registry UI.** Registry
   aggregate `SourceRegistryEntry` (`source_registry.py:177-196`), tables
   `source_registry_entries` (`database.py:2345`), `source_quality_stats`
   (`infrastructure/projections/sqlite_projection_store.py:258`), and
   `operational_attempt_metrics` (`sqlite_projection_store.py:288`, authored by
   `operational_metrics.py:record_operational_attempt_metric:123`). The source-quality
   projection is event-sourced (`infrastructure/projections/source_quality.py`,
   `SOURCE_QUALITY_EVENT_TYPES:19`, `project_source_quality:86`). It surfaces through
   `GET /v1/discovery/sources` → `listSourceRegistry` (`apps/api/src/server.ts:306`,
   `apps/api/src/discovery-controls.ts:434`), the dashboard `sourceHealth`
   (`read-model.ts:listSourceHealth:3549`), and the web UI
   `apps/web/src/contexts/discovery/components/DiscoveryProductControls.tsx` +
   `apps/web/src/views/dashboard/SourceHealthCard.tsx` (query keys
   `apps/web/src/contexts/discovery/queryKeys.ts` `sourceRegistry`/`sourceQuality`).
5. **Policy budgets feed the scheduler — not the fetch layer.**
   `DiscoveryScheduler.plan()` (`domain/discovery/scheduler.py:274`) consumes
   `SourcePolicy.max_pages_per_run` into a per-source `crawl_budget`
   (`scheduler.py:301`) that bounds the **result count** (`results_wanted` /
   new-jobs `limit` via `pipeline/runner.py:1154-1165`). Nothing consults it as a
   request **rate** or spacing.
6. **A shared cross-context network home.** `infrastructure/network/`
   (`__init__.py:1-7`) is the sanctioned place for adapters used by more than one
   bounded context. It currently holds only `ProxyConfig` / `parse_proxy`
   (`proxy.py`).

### The gap (verified absent across every fetch path)

1. **No robots.txt anywhere.** Repo-wide grep for `robots` returns zero hits. No
   fetch, parse, cache, honor, or "blocked by robots" outcome exists.
2. **No enforcement of rate, concurrency, or per-request budgets.** There is no
   `RateLimiter`, no token bucket, no per-host semaphore, no `crawl-delay`, and no
   `Retry-After` honoring anywhere. Concurrency is bounded only by
   `ThreadPoolExecutor(max_workers=…)` worker counts
   (`discovery/workday.py:620`, `discovery/smartextract.py:1404`,
   `enrichment/detail.py:1748`). The only pacing that exists is a fixed per-site
   `time.sleep(delay)` in the enrichment batch (`enrichment/detail.py:1032`,
   table `SITE_DELAYS:555-563`) — and **parallel worker mode removes even that**,
   because each site runs in its own thread with its own browser
   (`detail.py:1719-1748`), so N hosts are crawled simultaneously with no shared
   limiter. `jobspy`'s retry (`discovery/jobspy.py:81-85`) matches the string
   `"429"` for a fixed exponential backoff but never reads `Retry-After`.
3. **Dishonest UA on the live crawl paths.** The browser crawlers spoof
   `"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"`
   (`enrichment/detail.py:88` applied at `:205,687,713`;
   `infrastructure/enrichment/playwright_fetcher.py:34`;
   `discovery/smartextract.py:70`) and Workday's `urllib` calls spoof the same
   (`discovery/workday.py:174,186`). The ATS adapter fetcher
   (`ats_adapters.py:90-94`) is browser-prefixed but appends an honest project
   identity + URL. The honest identities in `LocatorPolicy` and the compensation
   feeds never reach the live crawlers.
4. **No shared fetch primitive to enforce any of the above.** `HttpFetcher` is a
   bare `Callable` alias (`ats_adapters.py:62`); every surface rolls its own
   transport — `urllib` (ATS adapters via `default_http_fetcher:72`, Workday,
   compensation), the `python-jobspy` library's own `tls-client`/`requests`
   stack, and Playwright (enrichment, apply). There is no single choke point
   where a UA, a robots check, a rate limit, or a budget could be applied.

### Complete outbound-fetch inventory (every surface this plan must route)

| # | Surface | Symbol · `file:line` | Transport | Targets | Politeness today |
| --- | --- | --- | --- | --- | --- |
| 1 | Broad-board aggregation | `_scrape_with_retry` `discovery/jobspy.py:63`, call `:78`; driver `_full_crawl:1055`, loop `:1135` | `python-jobspy` lib (`pyproject.toml:36`), own `tls-client`/`requests` | `indeed`, `linkedin`, `zip_recruiter`, `glassdoor` (`DEFAULT_JOBSPY_BOARDS` `config.py:53`) | retry backoff only (`:85`); no `Retry-After`, no pacing between searches |
| 2 | Workday CXS API | `workday_search:159`, `workday_detail:180`, driver `search_employer:195`, fan-out `scrape_employers:577` | raw `urllib.request` (`workday.py:149`) | `{base_url}/wday/cxs/{tenant}/{site}/jobs` | spoofed UA `:174,186`; page loop no sleep; thread-pool fan-out |
| 3 | ATS board APIs (`JobBoardScraperPort`) | `default_http_fetcher:72`; `WorkdayBoardAdapter:131`, `GreenhouseBoardAdapter:275`, `LeverBoardAdapter:391`, `AshbyBoardAdapter:498`; orch `run_scheduled_ats_sources` `production_wiring.py:468` | raw `urllib.request` (`ats_adapters.py:96`) | `boards-api.greenhouse.io`, `api.lever.co`, `api.ashbyhq.com`, Workday CXS | honest-ish UA `:90-94`; serial; 20s timeout; **no rate/robots** |
| 4 | Smart-extract listing/detail | `discovery/smartextract.py`, page nav `:402-405`, fan-out `:1404` | Playwright Chromium | configured sites (`config/sites.yaml`) | spoofed UA `:70`; thread-pool; no rate/robots |
| 5 | Enrichment detail crawl (LIVE path) | `scrape_site_batch:644` (reused browser `:713-716`, `page.goto:327`); driver `_run_detail_scraper:1622` (parallel `:1748`) | Playwright | every pending job's detail host | fixed `SITE_DELAYS` sleep `:1032`, **bypassed in parallel mode**; spoofed UA |
| 6 | Enrichment detail (port ref impl) | `PlaywrightDetailPageFetcher.fetch` `infrastructure/enrichment/playwright_fetcher.py:72` | Playwright | one detail URL | defined/exported but **not wired live**; spoofed UA `:34`; no rate/robots |
| 7 | WTTJ Algolia bootstrap | `resolve_wttj_urls:182`, `page.goto:207` | Playwright | WTTJ + its Algolia backend | spoofed UA; 60s timeout; no rate/robots |
| 8 | LinkedIn apply resolver | `LinkedInApplyUrlResolver:109`, `resolve:200`, retry loop `_reset_authenticated_linkedin_retry_candidates:1370` | Playwright persistent-context (real Chrome) | LinkedIn + external apply redirects to arbitrary ATS hosts | attempt cap 3 only; no rate/robots |
| 9 | Compensation feeds | `load_euro_top_tech_observations:692` (paginates `max_pages=10`), `_fetch_json:724`, `_fetch_text:675` | raw `urllib.request` | hardcoded eurotoptech API (`:70`); operator-configured licensed feeds | honest UA `"JobCtrl/0.3"`; page cap only; no rate/robots |
| 10 | Apply browser | `apply/chrome.py` (localhost CDP `:328`); real apply nav is CDP/agent-driven elsewhere | Playwright/CDP | localhost CDP + (elsewhere) employer apply pages | dry-run blocks non-local mutating requests (`:383`); no rate/robots on GETs |

**Thesis.** The declarative half of politeness already exists and is fail-closed.
This plan adds the **enforcement half**: one shared politeness gateway in
`infrastructure/network/` that every outbound fetch — `urllib`, the `jobspy`
invocation boundary, and every browser navigation — routes through. The gateway
consults `SourcePolicy` + robots.txt, applies a per-host rate limit + concurrency
cap + per-run request/page budget, stamps an honest UA, and records
**robots-blocked** and **rate-limited** as first-class per-source outcomes in the
existing source-quality read model so the user can see *why* a source yields
nothing. It extends `SourcePolicy` (never bypasses third-party controls) and
reuses the existing scheduler, projection, events, and registry UI rather than
inventing parallel machinery.

---

## Gates (both explicit, both required)

- **G1 — Pre-public-release gate for existing fetch paths.** The repository
  must not be published while the fetch paths in the inventory table run with no
  robots handling, no rate limiting, and browser-spoofed identities. Every
  surface #1–#10 must route through the gateway (or be explicitly, in writing,
  owner-accepted as residual) before the release flip. This gate slots alongside
  the release checklist in `docs/plans/2026-07-03-oss-release-remediation-spec.md`
  §5; record its completion there when it lands. It is independent of, and
  parallelizable with, the apply-safety workstream (W1) and privacy workstream (W0).
- **G2 — Hard prerequisite for future contact-research fetching.** Any future
  capability that fetches to discover or verify a contact (recruiter/hiring-manager
  research, company-page harvesting, email discovery, enrichment beyond the job
  post) MUST be built on this gateway and MUST NOT open a new ad-hoc fetch path.
  Contact-research fetching is **out of scope for this plan** (see Non-goals); this
  plan only makes it *possible to build safely later*. No contact-research code
  may merge until G1 is green.

---

## Phase plan

Each phase answers the repository acceptance template: **Source of truth ·
Owning context · Projection / read model · UI surface · Approving user action ·
Synthetic regression fixture · Local QA path**. Phases are stacked: P1 depends on
P0; P2/P3/P4 each depend on P1 and are internally parallelizable; P5 depends on
the outcome-recording contract from P1 plus at least one routed surface; P6 closes
the gate. Rip-and-replace: a phase that reroutes a surface deletes that surface's
old transport/UA in the same change.

---

### P0 — Politeness domain model, ports, and honest-UA policy (no behavior change)

**Objective.** Extend the existing policy substrate with the vocabulary the
enforcement layer needs, and declare the ports — without changing any fetch
behavior yet. This phase is purely additive types + Protocols + a TS mirror.

**Work items (objectives, not edits).**
1. **Extend `SourcePolicy`** (`source_registry.py:104`; TS mirror
   `source.ts:86`) with robots + rate/concurrency fields while preserving the
   fail-closed invariant:
   - a robots stance per `SourcePolicyMethod` (page-rendering methods
     `static_page` / `rendered_listing` / `rendered_detail` honor robots; the
     policy for documented-API methods `api` / `feed` is an **owner decision**,
     §Owner decisions D2);
   - a per-host **minimum request interval** (or requests-per-second) and a
     per-host **max concurrency**;
   - a per-run **request/page budget** (generalize the existing
     `max_pages_per_run`, which today only caps result count, so it also caps
     outbound requests — do not silently repurpose it; add the request budget as
     a distinct, explicitly-named field and keep `max_pages_per_run` meaning
     result volume).
   The `third_party_control_bypass=False` invariant and its `__post_init__`
   guard (`:126-127`) and the TS literal-`false` type stay exactly as they are.
2. **Add `ManualActionReason.ROBOTS_DISALLOWED`** (`source_registry.py:60`) and
   include it in the default `ManualInterventionPolicy.triggers` set
   (`:81-87`) so a robots denial is triage-classified like `RATE_LIMIT` /
   `BOT_DETECTION` today — **but distinct from an error** (see P1 for the
   outcome-vs-error distinction).
3. **Declare the ports** (Protocols) in `domain/ports/`, consistent with the
   existing Protocol-per-file pattern (`domain/ports/__init__.py` is
   docstring-only; adapters import submodules directly):
   - a `RobotsPort` — evaluate `(url, user_agent, method)` → allow / disallow /
     unknown, backed by a cache;
   - a `RateLimiterPort` — acquire/release a per-host slot honoring min-interval +
     concurrency;
   - a `PolitenessGatewayPort` — the single facade the fetch surfaces call:
     `check(url, source_policy, run_budget) → Decision` and a browser-friendly
     variant returning a pre-navigation verdict. Transport-agnostic by design so
     `urllib` callers and Playwright callers share one contract.
4. **Honest-UA policy value object.** A single source of the product's outbound
   identity (string + optional contact/project URL), replacing the four
   divergent UA literals. The exact value is an **owner decision** (§Owner
   decisions D1). Model it now; wire it in P2/P3.

**Invariants.** `SourcePolicy` remains frozen and fail-closed. No fetch path
imports the new ports yet. Both event/type registries stay in sync if any type is
added (Python `domain/discovery/__init__.py` + `domain/events/__init__.py`; TS
`packages/domain-types/src/discovery/source.ts` + `.../events/index.ts`).

**Acceptance (repo template).**
- *Source of truth:* the extended `SourcePolicy` (Python canonical +
  `packages/domain-types` mirror) and the honest-UA policy object.
- *Owning context:* Discovery (`domain/discovery`) for policy; shared network
  (`infrastructure/network`) for the port declarations' home context.
- *Projection / read model:* none changed in P0 (types only).
- *UI surface:* none in P0.
- *Approving user action:* none (no runtime behavior).
- *Synthetic regression fixture:* unit fixtures asserting (a) the fail-closed
  invariant still rejects `third_party_control_bypass=True` in both Python and TS;
  (b) `SourcePolicy` round-trips the new fields with sane defaults;
  (c) `ManualActionReason.ROBOTS_DISALLOWED` is a member and a default trigger.
- *Local QA path:* type/lint only — `uv --project workers/automation run --extra dev pytest -q`,
  `uv --project workers/automation run --extra dev ruff check .`,
  `pnpm --filter @jobctrl/contracts check`, `pnpm --filter @jobctrl/web test-d`.

---

### P1 — Shared politeness gateway adapter (the enforcement core)

**Objective.** Implement the gateway in `infrastructure/network/` (the sanctioned
cross-context home, `infrastructure/network/__init__.py:1-7`): robots
fetch+cache+evaluate, per-host rate limiter + concurrency semaphore, per-run
request/page budget, honest-UA stamping, and the **blocked-outcome recorder**.
No fetch surface is rerouted yet — this phase delivers the component and proves it
in isolation with the two mandated fixtures.

**Work items (objectives, not edits).**
1. **Robots adapter.** Fetch `/robots.txt` for a host, parse it (stdlib
   `urllib.robotparser` or an equivalent already-available parser — no new heavy
   dependency without owner sign-off), cache per host with a TTL (§Owner
   decisions D5), evaluate `can_fetch(user_agent, url)`. The robots fetch itself
   must be polite: short timeout, cached, and counted against the run budget.
   Encode standard semantics and flag the unreachable-robots behavior as an owner
   decision (§Owner decisions D6): `404` → allow; explicit `Disallow` match →
   deny; repeated `5xx`/timeout → conservative treatment recorded, never a silent
   allow.
2. **Rate limiter + concurrency.** A **process-shared, host-keyed** limiter
   (token bucket / min-interval) plus a per-host concurrency semaphore. It MUST be
   thread-safe because the crawlers fan out with `ThreadPoolExecutor`
   (`workday.py:620`, `detail.py:1748`, `smartextract.py:1404`); a per-thread or
   per-call limiter would re-introduce the parallel-mode bypass and is a defect.
3. **Per-run budget.** A request/page counter scoped to a discovery/enrichment
   run; when exhausted, further fetches are refused with a distinct, recordable
   reason (budget-exhausted), not an exception that reads as a site failure.
4. **Honest-UA stamping.** The gateway is the only place the outbound UA is set;
   it applies the P0 honest-UA policy to `urllib` headers and returns the UA for
   Playwright callers to set on their context.
5. **Blocked-outcome recorder.** robots-deny, rate-limit deferral/refusal, and
   budget-exhaustion are recorded as **first-class outcomes, not errors**, through
   the existing `record_operational_attempt_metric`
   (`operational_metrics.py:123`) with an outcome/failure-category that
   `classify_failure` (`:80`) treats as *non-error* (i.e. not
   `is_operational_failure` / not `is_scrape_failure`), and folded into the
   source-quality projection (`source_quality.py`,
   `SOURCE_QUALITY_EVENT_TYPES:19`). This is the RCA-discipline requirement: the
   surface must prove *why* a source produced nothing, sourced from the actual
   gateway decision, not inferred.
6. **Honoring `Retry-After`.** Where the transport exposes it, the limiter honors
   a `Retry-After` on `429`/`503` (the current `jobspy`/detail paths ignore it —
   `jobspy.py:81`, `detail.py:300-403`).

**Invariants.** One code path enforces robots + rate + concurrency + budget + UA;
callers cannot fetch around it. A robots denial and a rate-limit are recorded as
outcomes, never as a scrape failure. The limiter is shared across threads.

**Acceptance (repo template).**
- *Source of truth:* the gateway's own decision (robots verdict, limiter state,
  budget counter) — the canonical record of every deny/limit.
- *Owning context:* shared network (`infrastructure/network`), consumed later by
  Discovery, Enrichment, Compensation.
- *Projection / read model:* extends `source_quality_stats`
  (`sqlite_projection_store.py:258`) / `operational_attempt_metrics`
  (`:288`) via the existing writer + projection so blocked/limited counts land in
  the rolling source-health window.
- *UI surface:* none in P1 (surfacing is P5); the data must already be recorded.
- *Approving user action:* none at runtime; the recorded outcome later drives the
  user's quarantine/disable/policy decision in P5.
- *Synthetic regression fixture (both mandated fixtures live here):*
  - **robots-deny fixture** — a local HTTP server serving a `robots.txt` with a
    `Disallow` for the crawl path; assert the gateway returns *disallow*, records
    a `ROBOTS_DISALLOWED` outcome (not an error), and performs **zero** fetches of
    the disallowed path.
  - **rate-limit fixture** — drive the gateway concurrently (thread pool) for one
    host and assert: the observed min-interval between requests is respected, the
    per-host concurrency cap is never exceeded, `Retry-After` is honored, and the
    per-run budget stops further requests with a budget-exhausted outcome.
  - plus: robots cache TTL behavior; unreachable-robots behavior per the chosen
    D6 semantics.
- *Local QA path:* `uv --project workers/automation run --extra dev pytest -q`
  (gateway unit + integration fixtures), `ruff check .`. No live network — the
  fixtures use a loopback server.

---

### P2 — Route all non-browser HTTP through the gateway

**Objective.** Every `urllib`/library HTTP caller fetches through the P1 gateway:
the ATS adapters, Workday, compensation, and the `jobspy` invocation boundary.
Delete the per-caller UA literals and ad-hoc transports they replace.

**Work items (objectives, not edits).**
1. **ATS adapters.** Replace `default_http_fetcher` (`ats_adapters.py:72`) and the
   bare `HttpFetcher` alias (`:62`) so the injected fetcher is the gateway-backed
   client, carrying the source's `SourcePolicy` and the run budget. Inject it at
   the composition root: `_adapter_for_source` (`production_wiring.py:1768`,
   already threads an `http=` kwarg) fed from `run_scheduled_ats_sources`
   (`:468`), whose callers `pipeline/runner.py:1451,2116` currently pass no `http`
   and thus default each adapter to its own `urllib`. Wire the gateway there.
   Remove the duplicated UA at `ats_adapters.py:90-94` (identity now comes from
   the honest-UA policy). Robots scope per D2 for `api` sources.
2. **Workday.** Route `workday.py`'s `urllib` opener/requests (`:149,171,184`)
   through the gateway; delete the spoofed UA (`:174,186`); the page loop
   (`search_employer:195`) and thread-pool fan-out (`scrape_employers:577`) pace
   via the shared limiter, not raw iteration.
3. **Compensation.** Route `_fetch_json` (`sqlite_market_repository.py:724`) and
   `_fetch_text` (`:675`) through the gateway; the eurotoptech pagination
   (`load_euro_top_tech_observations:692`, `max_pages=10`) counts against the run
   budget and paces via the limiter. Keep the already-honest `"JobCtrl/0.3"`
   behavior by sourcing it from the honest-UA policy.
4. **`jobspy` invocation boundary.** The `python-jobspy` library owns its own
   transport (`tls-client`/`requests`) and cannot be robots-gated per internal
   request. Enforce politeness at the **invocation boundary** instead
   (`discovery/jobspy.py` `_run_one_search:841`, `_full_crawl:1055`,
   `run_discovery:1207`): gate whether a broad-board source runs at all per its
   `SourcePolicy` + registry `state`, apply the per-run request budget and
   inter-search pacing via the shared limiter, and record a rate-limited/blocked
   outcome when the budget or policy stops it. The residual (jobspy's own internal
   requests are unpoliced) is an explicit owner decision + documented risk
   (§Owner decisions D3, §Risks).

**Invariants.** After P2, grep proves no non-browser surface constructs its own
`urllib.request`/library HTTP for outbound crawling outside the gateway (the LLM
client `llm.py:369` and localhost CDP `chrome.py:328` are explicitly exempt — see
Non-goals). No spoofed UA literal remains in the non-browser paths.

**Acceptance (repo template).**
- *Source of truth:* `SourcePolicy` per source + the gateway decision.
- *Owning context:* Discovery (ATS/Workday/jobspy) and Compensation
  (`infrastructure/compensation`).
- *Projection / read model:* per-source robots/rate/budget outcomes recorded via
  P1 into `source_quality_stats` / `operational_attempt_metrics`.
- *UI surface:* none new (P5 renders it); outcomes must already record.
- *Approving user action:* none at runtime.
- *Synthetic regression fixture:* per-surface fixtures driving each adapter
  against a loopback server proving (a) requests carry the honest UA;
  (b) a `Disallow`ed page-method source is not fetched and records
  `ROBOTS_DISALLOWED`; (c) the run budget caps request count; (d) the jobspy
  boundary refuses/records when policy or budget blocks (library stubbed — no real
  board traffic). Reuse the P1 loopback harness.
- *Local QA path:* `uv --project workers/automation run --extra dev pytest -q`,
  `ruff check .`, and `pnpm api:check`/`pnpm api:test` if the compensation refresh
  contract surface changes.

---

### P3 — Route all browser-based fetches through the gateway

**Objective.** Every Playwright navigation obeys the **same** robots + rate +
concurrency + budget as the HTTP paths (goal: browser fetches are not a bypass).
Replace the fixed `SITE_DELAYS` sleep with the shared limiter so parallel mode
stops bypassing pacing, and apply the honest UA to every browser context.

**Work items (objectives, not edits).**
1. **Pre-navigation gate.** Before every `page.goto`, call the gateway's
   browser-variant verdict for `(url, source_policy, run_budget)`; a robots-deny
   or budget-exhaustion skips the navigation and records the outcome — it never
   navigates and relabels. Cover the LIVE path `scrape_detail_page:304`
   (`page.goto:327`) driven by `scrape_site_batch:644`, `resolve_wttj_urls:182`
   (`:207`), the LinkedIn resolver `LinkedInApplyUrlResolver.resolve:200`
   (`:206`) and its retry loop `_reset_authenticated_linkedin_retry_candidates:1370`,
   and the port reference impl `PlaywrightDetailPageFetcher.fetch:72`. Note: a
   politeness layer added only at the `DetailPageFetcherPort` would **miss the live
   path**, which drives Playwright directly — both must route.
2. **Shared limiter replaces `SITE_DELAYS`.** Delete the fixed per-site sleep
   (`detail.py:1032`, table `:555-563`) in favor of the P1 host-keyed limiter, so
   the `ThreadPoolExecutor` parallel mode (`_run_detail_scraper:1622`,
   `:1748`) can no longer crawl N hosts with no shared pacing. Per-host concurrency
   cap applies across threads.
3. **Honest UA everywhere.** Every `browser.new_context(user_agent=…)` /
   `new_page(user_agent=…)` uses the honest-UA policy; delete the spoofed literals
   (`detail.py:88`, `playwright_fetcher.py:34`, `smartextract.py:70`,
   `workday.py` covered in P2). The LinkedIn persistent-context (real Chrome,
   `linkedin_apply_resolver.py:173`) is an owner-scoped, user-authenticated
   session — its UA and robots treatment are an owner decision (§Owner decisions
   D1/D3): the product still must not evade controls, but a logged-in user session
   differs from anonymous crawling.
4. **Apply browser.** The apply flow's real page navigation (CDP/agent-driven,
   outside `apply/chrome.py`) obeys the same budgets; localhost CDP
   (`chrome.py:328`) is exempt (loopback, and already dry-run-guarded at `:383`).
   State the seam and its budget obligation explicitly; do not duplicate the
   apply-safety work owned by the OSS spec W1 (see Non-goals).

**Invariants.** No `page.goto` runs without a gateway verdict. No spoofed browser
UA literal remains. Parallel-mode enrichment respects per-host limits.

**Acceptance (repo template).**
- *Source of truth:* `SourcePolicy` per source + the gateway verdict.
- *Owning context:* Enrichment (`enrichment`, `infrastructure/enrichment`) and
  Apply (browser navigation seam only).
- *Projection / read model:* per-host skip/limit outcomes recorded via P1 into the
  source-quality read model.
- *UI surface:* none new (P5).
- *Approving user action:* none at runtime.
- *Synthetic regression fixture:* a loopback "employer" server with a `Disallow`
  robots and a rate assertion; assert the browser path performs **zero**
  navigations to the disallowed path, records `ROBOTS_DISALLOWED`, and that a
  two-host parallel enrichment run respects per-host min-interval + concurrency
  (this is the browser-side rate-limit fixture, complementing P1's HTTP-side one).
- *Local QA path:* `uv --project workers/automation run --extra dev pytest -q`
  (Playwright-optional fixtures gated as elsewhere in the suite);
  `docs/local-reliability-qa.md` gains a manual enrichment-dry-run QA entry (no
  real applications, loopback only).

---

### P4 — Surface robots-blocked / rate-limited outcomes in the registry + quality UI

**Objective.** The user sees *why* a source yields nothing: robots-blocked,
rate-limited, or budget-exhausted, distinct from a scrape error. Extend the
existing read model, contracts, events, and registry/dashboard UI — reusing the
source-quality machinery, not a parallel surface.

**Work items (objectives, not edits).**
1. **Read model.** Extend `source_quality_stats`
   (`sqlite_projection_store.py:258`, mirror `apps/api/src/projections.ts:558`)
   and the projection (`source_quality.py:project_source_quality:86`) with
   robots-blocked / rate-limited / budget-exhausted counts (or a
   last-block-reason), sourced from the P1 outcomes. Surface via
   `listSourceRegistry` (`discovery-controls.ts:434`, joins quality) and
   `listSourceHealth` (`read-model.ts:3549`).
2. **Contracts.** Extend `SourceRegistryEntrySummary` (`schemas.ts:2915-2935`)
   and `SourceHealthSummary` (`schemas.ts:2196-2216`) with the new reason/counts;
   keep `RECOMMENDED_SOURCE_STATES` (`:2906`) semantics — a persistently
   robots-blocked source should recommend `quarantined`/`disabled` via the
   existing demotion path (`scheduler._recommended_state:383`,
   `source_quality._recommended_state:421`).
3. **Events + parity.** If a new event type is required (e.g. a
   `SourceAccessBlocked`-style fact), land it in **both** registries
   (`domain/events/__init__.py` + `packages/domain-types/src/events/index.ts`),
   add a web invalidation handler (`apps/web/src/contexts/discovery/handlers.ts`,
   which already maps `SourceStateChanged`/`DiscoveryRun*` → `sourceRegistry`/
   `sourceQuality`), and web fixtures — keeping `every-event-has-handler.test.ts`
   green. Prefer reusing `SourceStateChanged` (`reason`) +
   `DiscoveryFeedbackRecorded` where they already carry the signal, to avoid event
   sprawl.
4. **UI.** Render the reason in `DiscoveryProductControls.tsx` (per-source state +
   quality chips) and `SourceHealthCard.tsx` (dashboard) so a zero-yield source
   shows "blocked by robots" / "rate-limited" / "budget reached" instead of an
   empty or generically-failed row.

**Invariants.** Every displayed block reason has an explicit source of truth (the
P1 gateway outcome) — no inference from empty results. Parity/exhaustiveness tests
stay green. robots-blocked reads as an *outcome*, never as an error badge.

**Acceptance (repo template).**
- *Source of truth:* the recorded gateway outcome, projected into
  `source_quality_stats`.
- *Owning context:* Operations (read-model/projection) + Discovery (registry UI).
- *Projection / read model:* `source_quality_stats` / `operational_attempt_metrics`
  → `listSourceRegistry` / `listSourceHealth`.
- *UI surface:* `DiscoveryProductControls.tsx`, `SourceHealthCard.tsx` (query keys
  `discoveryKeys.sourceRegistry`/`sourceQuality`).
- *Approving user action:* the user reads the reason and quarantines/disables the
  source or adjusts its policy (existing `PATCH /v1/discovery/sources/:id/state`
  `server.ts:335`; policy-edit affordance is an owner decision, §D4).
- *Synthetic regression fixture:* a projection fixture that folds a
  robots-blocked and a rate-limited outcome from canonical events and asserts the
  read-model row exposes the reason + counts; a web component fixture asserting the
  registry row and dashboard card render "blocked by robots" / "rate-limited" from
  that read model (reproduce the bad state from data, not a shallow snapshot).
- *Local QA path:* `pnpm api:check`, `pnpm api:test`, `pnpm --filter @jobctrl/web test`,
  `pnpm --filter @jobctrl/web test-d`, `pnpm web:check`, and
  `pnpm --filter @jobctrl/web e2e` for the discovery source view if the E2E
  surface changes.

---

### P5 — Config surface, honest-UA finalization, defaults, docs, and gate closure

**Objective.** Make politeness configurable where discovery config already lives,
finalize the owner decisions, set fail-closed defaults, add operator disclosure +
`doctor` notices, and record the gate as met.

**Work items (objectives, not edits).**
1. **Config surface.** Politeness knobs (per-host rate/concurrency defaults, run
   budget defaults, robots TTL, honest-UA/contact string) live where discovery
   config lives today — module defaults in `config.py`
   (`DEFAULT_DISCOVERY_SEARCH_CONFIG:57`, `DEFAULTS:1087`), the DB-backed
   `discovery_settings` blob (`config.py:272-345`; API mirror
   `apps/api/src/discovery-controls.ts:310-335`), and the TS `DiscoverySettings*`
   contract (`schemas.ts:2838-2861`) surfaced in the discovery settings panel
   (`DiscoveryRuntimeSettingsPanel.tsx`). Per-source overrides ride on the
   existing `SourcePolicy` attached to each `SourceRegistryEntry` and its DB
   override rows (`source_registry_entries`, `config.py:_merge_local_source_registry:943`).
   Enumerate: env vars (`.env.example`), module defaults, the `discovery_settings`
   blob, per-source `SourcePolicy`, and `config/sites.yaml`/`employers.yaml`.
2. **Honest-UA finalization.** Resolve §Owner decisions D1: the exact UA string
   and whether to include a contact/project URL; converge all four prior identities
   onto it. Do not reproduce the owner's personal identity in the UA.
3. **Fail-closed defaults.** Defaults must be conservative: robots honored for
   page-rendering methods, a non-zero min-interval, a bounded per-host concurrency,
   and a finite run budget out of the box.
4. **`doctor` + disclosure.** `doctor` prints notices when broad boards
   (`DEFAULT_JOBSPY_BOARDS`) are active, when a source is robots-blocked/quarantined,
   and the effective UA. Extend `docs/user/data-and-safety.md` and
   `docs/user/security.md` (responsible-use + scraping-source ToS/robots posture),
   `README.md` (safety notes + UA), `docs/architecture/**` (a politeness section in
   `runtime.md` or the pipeline docs), `docs/local-reliability-qa.md` (QA entries),
   and add an ADR to `docs/decisions.md` ("Crawl politeness / third-party-control
   compliance layer"). Note: this deliverable is a single plan file; those doc
   edits land with the implementing phases, not here.
5. **Gate closure.** Record G1 as met against the release checklist
   (`docs/plans/2026-07-03-oss-release-remediation-spec.md` §5) and confirm G2's
   prerequisite standing for any future contact-research work.

**Acceptance (repo template).**
- *Source of truth:* the discovery-settings blob + per-source `SourcePolicy` + the
  honest-UA policy.
- *Owning context:* Discovery + Profile (settings form) + Operations (doctor/health).
- *Projection / read model:* settings read via existing settings/discovery-settings
  read paths; no new projection.
- *UI surface:* `DiscoveryRuntimeSettingsPanel.tsx` (+ the profile settings form if
  a global UA/politeness toggle is added).
- *Approving user action:* the user sets politeness config and the honest-UA/contact
  string; the user opts broad boards on/off with disclosure.
- *Synthetic regression fixture:* a settings round-trip fixture (API + web) proving
  politeness knobs persist to `discovery_settings` and reach the worker;
  a `doctor` unit test for the new notices.
- *Local QA path:* full sweep — `pnpm test`, `pnpm check`,
  `uv --project workers/automation run --extra dev pytest -q`, `ruff check .`,
  `python3 scripts/release_check.py` (must stay zero-findings; PR text and docs
  must remain PII-clean).

---

## Verification (exact commands from `CLAUDE.md`)

Run the commands for every surface a phase touched; the full sweep before opening
each PR.

| Surface | Command | Required result |
| --- | --- | --- |
| Python worker tests | `uv --project workers/automation run --extra dev pytest -q` | 100% pass |
| Python lint | `uv --project workers/automation run --extra dev ruff check .` | `All checks passed!` |
| Python package build | `uv --project workers/automation run --extra dev python -m build workers/automation` | builds clean |
| TS API typecheck | `pnpm api:check` | zero errors |
| TS API tests | `pnpm api:test` | all pass |
| API QA harness | `pnpm qa:test` | all pass (for P3/P4 product-path changes) |
| Web typecheck | `pnpm web:check` | zero errors |
| Web unit/hook/component | `pnpm --filter @jobctrl/web test` | all pass |
| Web type-level | `pnpm --filter @jobctrl/web test-d` | all pass |
| Web E2E (discovery view) | `pnpm --filter @jobctrl/web e2e` | pass (P4 if UI changes) |
| Contracts typecheck | `pnpm --filter @jobctrl/contracts check` | zero errors |
| Full check | `pnpm check` | zero errors |
| Full sweep (pre-PR) | `pnpm test` | all pass |
| Privacy (always) | `python3 scripts/release_check.py` | zero findings |
| Hygiene | `git diff --check` | clean |

All fixtures use a loopback HTTP server; **no live network, no real board
traffic, no applications, nothing spendful** is run during verification.

---

## Definition of Done (checkable)

- [ ] P0 landed: `SourcePolicy` extended with robots + per-host rate/concurrency +
      run request budget; `ManualActionReason.ROBOTS_DISALLOWED` added; ports
      declared; honest-UA policy modelled; fail-closed invariant unchanged in both
      Python and TS.
- [ ] P1 landed: the gateway enforces robots + rate + concurrency + budget + honest
      UA, is process-shared/host-keyed/thread-safe, honors `Retry-After`, and
      records robots-deny / rate-limit / budget-exhaustion as **outcomes, not
      errors**. Both mandated fixtures pass (robots-deny + rate-limit).
- [ ] **All outbound fetch paths route through the gateway** — grep-provable that
      surfaces #1–#10 no longer construct ad-hoc outbound transport (exempt: LLM
      client `llm.py`, localhost CDP `chrome.py`):
  - [ ] ATS adapters (#3) + Workday (#2) + smart-extract (#4) + compensation (#9)
        and the `jobspy` invocation boundary (#1) — P2.
  - [ ] Enrichment live batch (#5) + port ref impl (#6) + WTTJ (#7) + LinkedIn
        resolver (#8) + apply browser nav seam (#10) — P3.
- [ ] No spoofed browser-UA literal remains on any product fetch path; one honest
      UA (owner-approved) is used everywhere.
- [ ] Parallel-mode enrichment respects per-host limits (the `SITE_DELAYS` sleep is
      deleted in favor of the shared limiter).
- [ ] robots-blocked / rate-limited / budget-exhausted reasons are surfaced per
      source in `DiscoveryProductControls.tsx` + `SourceHealthCard.tsx`, sourced
      from the recorded outcome — parity/exhaustiveness tests green (P4).
- [ ] Politeness is configurable via the existing discovery-settings surface, with
      conservative fail-closed defaults; `doctor` discloses UA + blocked sources +
      broad-board activity; docs updated (README, data-and-safety, security,
      architecture, local-reliability-qa) + ADR recorded (P5).
- [ ] `python3 scripts/release_check.py` zero findings; all PR text PII-clean.
- [ ] **Gate status:** G1 recorded as met on the release checklist
      (`2026-07-03-oss-release-remediation-spec.md` §5); G2 prerequisite confirmed
      (no contact-research fetch path merged ahead of G1).

---

## Non-goals

- **No third-party-control evasion, ever.** This plan extends the fail-closed
  `SourcePolicy` stance; it does not add a bypass toggle, a CAPTCHA-evasion path,
  or a "disable robots" escape hatch. Per the existing RFC stance, a source that
  cannot be accessed without evasion is routed to a permissioned API, licensed
  feed, manual import, or user-mediated capture — not scraped harder.
- **No contact-research fetching.** Recruiter/hiring-manager research, company-page
  harvesting, and email discovery are explicitly out of scope; this plan is the
  prerequisite (G2) that must land first.
- **No hosted/distributed rate limiter.** The gateway is local, single-process.
  The hosted per-tenant concurrency/rate-limit item (`docs/backlog.md:268`) is a
  separate future seam; this plan should leave a clean port so a hosted adapter can
  replace the local limiter later.
- **No change to the LLM provider HTTP** (`llm.py:369`, `httpx`) — it is an
  authenticated model API, not a crawl target; LLM spend is governed separately by
  the existing spend-budget system.
- **No change to what is extracted or to dedup/identity logic** — this is about how
  we fetch, not what we parse.
- **No apply-submission safety changes** — the at-most-once apply gate and
  explicit dry-run guard for dry-run requests are owned by the OSS spec W1; this
  plan only requires that apply's browser *navigation* obey the same budgets.

## Risks

- **Yield reduction.** Honoring robots and dropping browser-spoofed UAs may reduce
  results on sources that block honest automated clients (some broad boards, WTTJ,
  LinkedIn). Mitigation: surface robots-blocked as a first-class outcome (P4) so the
  user understands *why*, and route blocked sources to permissioned/manual
  alternatives per the existing stance — the product is honest by design, not
  maximally extractive.
- **`jobspy` opacity.** The `python-jobspy` library owns its transport and cannot
  be robots-gated per internal request; politeness is enforced only at its
  invocation boundary. Residual risk is documented and is an owner decision (D3).
- **Parallel-mode correctness.** If the limiter is not process-shared and
  host-keyed, `ThreadPoolExecutor` fan-out re-introduces the bypass. This is called
  out as a hard invariant with a dedicated parallel fixture.
- **robots fetch failure modes.** Aggressive fail-closed on unreachable robots
  could strand a healthy source; a naive fail-open defeats the gate. The chosen
  semantics (D6) must be explicit and tested.
- **Authenticated LinkedIn session.** The persistent-context resolver is a
  logged-in *user* session, semantically distinct from anonymous crawling; its
  robots/UA treatment needs an explicit owner call (D1/D3) to stay honest without
  breaking a user-authorized flow.

## Owner decisions (STOP and confirm before the relevant phase)

**Historical note (2026-07-06):** All six decisions below were resolved during
implementation of the stacked politeness PRs (#297–#316); each now carries a
`Resolved (2026-07-06, implemented)` record with the shipped choice and verified
code anchors, so the "STOP and confirm before the relevant phase" framing reads as
historical. Two residues are deliberately left on the owner pile and flagged
inline: the final honest-UA contact string (D1) and the per-source policy editor /
web knobs (D4).

- **D1 — Honest UA string + contact.** The exact outbound user-agent and whether
  to include a contact/project URL. An existing example already embeds the project
  repository URL as contact (`ats_adapters.py:90-94`); the honest locator UA is
  `"JobCtrl Source Locator (local)"` and the compensation UA is `"JobCtrl/0.3"`.
  Owner picks the single canonical value. (Blocks P0 modelling / P5 finalization.)
  - **Resolved (2026-07-06, implemented):** Canonical honest UA
    `JobCtrl/<version> (+https://github.com/ebarti/JobCtrl)`, produced by
    `default_honest_user_agent()` and funnelled through the single resolution point
    `resolve_honest_user_agent()` (`infrastructure/network/politeness.py:63`), which
    every `PolitenessGateway` uses for its default UA (`politeness.py:122`). Owner
    env overrides `JOBCTRL_CRAWL_UA_PRODUCT` (`politeness.py:56`) and
    `JOBCTRL_CRAWL_UA_CONTACT` (`politeness.py:59`); an empty contact drops the
    `(+contact)` suffix (`politeness.py:78`). The identity is stamped at call time
    on the three Playwright surfaces — `PlaywrightDetailPageFetcher`
    (`infrastructure/enrichment/playwright_fetcher.py:128`),
    `smartextract.collect_page_intelligence` (`discovery/smartextract.py:431`), and
    `detail.scrape_site_batch`'s anonymous context (`enrichment/detail.py:994`) —
    proven by `tests/test_browser_ua_propagation.py` (robots identity == fetch
    identity == owner override). It never impersonates a browser on surfaces we
    control. **Owner-pending:** the final contact-string value, surfaced in
    `docs/user/configuration.md` and `jobctrl doctor` (`cli.py:1819`) for the
    owner to review before real crawls.
- **D2 — robots scope by method.** Whether documented public JSON APIs
  (`SourcePolicyMethod.api`/`feed`: Greenhouse/Lever/Ashby/Workday CXS,
  eurotoptech) are robots-checked at their API host, or whether robots enforcement
  applies to page-rendering methods (`static_page`/`rendered_listing`/`rendered_detail`)
  with API methods relying on the documented-API contract. (Blocks P2.)
  - **Resolved (2026-07-06, implemented):** Robots enforcement applies to
    page-rendering methods; documented public JSON APIs are exempt at their API host
    via `RobotsPolicy.EXEMPT_DOCUMENTED_API`
    (`domain/discovery/source_registry.py:65`), applied to the ATS canonical API
    policy (Greenhouse/Lever/Ashby, `source_registry.py:198`) and the Workday CXS
    API policy (`source_registry.py:189`) — both `allowed_methods=(SourcePolicyMethod.API,)` —
    and to the documented compensation feeds via `COMPENSATION_FEED_POLICY`
    (`allowed_methods=(SourcePolicyMethod.FEED,)`, robots EXEMPT at
    `infrastructure/compensation/sqlite_market_repository.py:86-89`), which govern
    Euro Top Tech (`sqlite_market_repository.py:80`) and the other operator-configured
    compensation feeds. The exemption is robots-off only: the gateway still stamps the
    honest UA and applies per-host pacing/concurrency + the per-run request budget to
    these feeds (`sqlite_market_repository.py:83-85`). Page-rendering policies keep
    `RobotsPolicy.HONOR` (`source_registry.py:135` default, `:214` enrichment).
- **D3 — `jobspy` broad-board posture.** Keep broad boards with invocation-boundary
  budget + pacing + outcome recording (accepting jobspy's internal requests are
  unpoliced), or gate broad boards behind explicit opt-in + disclosure as
  `lead_generator` sources. Also: robots/UA treatment for the authenticated
  LinkedIn resolver session. (Blocks P2/P3.)
  - **Resolved (2026-07-06, implemented):** Broad boards kept, policed at *our*
    invocation boundary (jobspy owns its per-board transport): a per-run
    search-invocation budget + inter-search pacing on the shared `jobspy`
    host-limiter bucket + a `budget_exhausted` outcome recorded when the budget stops
    a crawl — `discovery/jobspy.py:67-69` and `:1134-1198` (`politeness_ua` `:1143`,
    `search_budget` `:1145`, recording `:1187-1198`). jobspy's internal per-board
    requests remain unpoliced and are honestly labelled in-code (`jobspy.py:67`). The
    authenticated LinkedIn resolver is an owner-scoped carve-out: robots OFF on the
    owner's logged-in session via `_OwnerAuthenticatedRobots` (`enrichment/detail.py:102`)
    on the batch path (`detail.py:980`) and the recovery pre-pass (`detail.py:1728`),
    while rate + budget stay ON everywhere — the recovery pass is gated through
    `session.guard` and defers with `politeness_deferred` when budget/rate blocks
    (`detail.py:615`, `:1814`). `user_agent=None` at every `LinkedInApplyUrlResolver(...)`
    construction (`detail.py:1683`), AST-enforced by
    `tests/test_fetch_surface_enforcement.py::test_authenticated_linkedin_context_never_uses_bot_ua_at_any_site`.
- **D4 — Default rate / concurrency / budget values.** Per-host min-interval (or
  req/s), per-host max concurrency, and per-run request/page budget defaults; and
  whether the registry UI exposes a per-source policy editor. (Blocks P1 defaults /
  P4 UI / P5 config.)
  - **Resolved (2026-07-06, implemented):** Conservative fail-closed defaults:
    `SourcePolicy` defaults to `RobotsPolicy.HONOR`
    (`domain/discovery/source_registry.py:135`); `ENRICHMENT_CRAWL_POLICY`
    (`source_registry.py:209`) sets robots HONOR (`:214`),
    `min_request_interval_seconds=2.0` (`:215`, subsuming the old fixed `SITE_DELAYS`
    sleep), `max_concurrent_requests_per_host=1` (`:216`), and a
    `max_requests_per_run=1000` runaway-navigation safety valve (`:217`). Override
    wiring is generic env/config (the honest-UA envs above; per-host overrides noted
    as an owner/config concern at `source_registry.py:208`). **Owner-deferred:** the
    per-source policy editor / web knobs — the registry UI surfaces politeness
    outcomes read-only, with no policy-edit affordance.
- **D5 — robots cache TTL.** Default TTL for cached `robots.txt`. (Blocks P1.)
  - **Resolved (2026-07-06, implemented):** robots cache TTL = 1h on success
    (`DEFAULT_ROBOTS_TTL_SECONDS = 3600.0`, `infrastructure/network/robots.py:36`)
    and 5min on fail-closed/unreachable results so they re-check soon
    (`UNREACHABLE_ROBOTS_TTL_SECONDS = 300.0`, `robots.py:39`).
- **D6 — Unreachable-robots semantics.** Behavior on `5xx`/timeout when fetching
  `robots.txt` (conservative-deny-until-refetch vs allow-with-record), consistent
  with the fail-closed stance. (Blocks P1.)
  - **Resolved (2026-07-06, implemented):** `RobotsCache._fetch`
    (`infrastructure/network/robots.py:96`): `2xx` → parse and enforce (`:100`);
    `4xx` incl. `404` → allow (robots absent, `:107`); `5xx` → fail-closed, disallow
    until retry (`:104`); timeout → fail-closed (`:109`); DNS failure / connection
    refused → fail-open with a warning (`:112`, `:117`); any other error →
    fail-closed (`:120`). Fail-closed results carry the short 300s recheck TTL via
    `_unreachable` (`:136`). The yield trade-off (fail-open on definitive
    DNS/refused absence vs fail-closed on ambiguous 5xx/timeout) is documented in the
    module docstring (`robots.py:1-13`).

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
