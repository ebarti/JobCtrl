# Product Rename to JobCtl — Execution Plan

> **Status:** Proposed (2026-07-05). Not yet scheduled — this is the LAST
> pre-publication change and is gated on the preflight in §3.
> **Anchors verified against main @ `a488e4e9`** (`a488e4e9853dde292badc74a88c7de24160edc52`).
> **Type:** atomic product rename, clean break, NO compatibility shims.
> **Audience:** capable implementing agents at high reasoning effort. This
> document fixes objectives, invariants, contracts, gates, and acceptance
> criteria; it does not prescribe line-by-line edits. Where several sound
> implementations exist, choose one and record it in the PR.

---

## 0. Summary

The product is publicly renamed from **JobHunter** to **JobCtl** before the
open-source release. This is a single-user, local-first product; the owner has
authorized a clean break with **no compatibility shims, no dual-name aliases,
no deprecation wrappers** (consistent with the standing rip-and-replace rule in
`CLAUDE.md` and the OSS remediation spec §0.4). Every occurrence of the old
name in shipping surfaces is replaced; running local state is migrated once, in
place, the first time a renamed process starts.

Footprint measured at HEAD `a488e4e9`:

| Metric | Value | How measured |
| --- | --- | --- |
| Files containing the name (any case) | **766** | `rg -il jobhunter \| wc -l` |
| Total occurrences (any case) | **4540** | `rg -i --count-matches jobhunter` summed |
| `JobHunter` (PascalCase) | 473 | `rg --count-matches 'JobHunter'` summed |
| `jobhunter` (lowercase) | 3720 | `rg --count-matches 'jobhunter'` summed |
| `JOBHUNTER` (uppercase) | 344 | `rg --count-matches 'JOBHUNTER'` summed |

The bulk (3720 lowercase) is the Python import package
`workers/automation/src/jobhunter/` — **1820** `from jobhunter …` / `import
jobhunter …` lines across **393** worker files — plus **408**
`@jobhunter/*` package references in the TypeScript workspace.

### 0.1 Relationship to the OSS release remediation spec (supersedes a locked decision)

The active spec `docs/plans/2026-07-03-oss-release-remediation-spec.md` §1
records a *locked* decision: "the GitHub repo and product name stay
`JobHunter`. Only the PyPI distribution name changes (W2.1)". **This plan
overrides that decision** with a new owner directive: rename the whole product
to JobCtl. Concretely, this plan **subsumes and replaces OSS spec §W2.1** (the
PyPI-distribution-only rename and its owner checkpoint) — the distribution,
import package, console script, and product name all move together here. The
release-gate checklist in that spec (§5) gains the line "product rename to
JobCtl complete" as its final pre-flip item.

The spec-side half of this decision is PR #257 ("defer naming and PyPI
publishing to the pre-publication rename train"): it removes §W2.1 from the
active OSS program and points the spec at this train. The two PRs compose —
#257 edits the spec, this plan is the train it defers to; merge both.

Evidence the direction was pre-staged: the docs-site deploy workflow already
targets a Cloudflare Pages project named `jobctl-docs`
(`.github/workflows/docs-site.yml:77`). That is the only pre-existing `jobctl`
literal in the tree.

---

## 1. The rename decision (locked) and derived name map

| Concept | Old | New |
| --- | --- | --- |
| Product / brand name | JobHunter | JobCtl |
| pnpm scope | `@jobhunter/*` | `@jobctl/*` |
| Root workspace package `name` | `jobhunter` | `jobctl` |
| Python import package | `jobhunter` (`src/jobhunter/`) | `jobctl` (`src/jobctl/`) |
| Python console script | `jobhunter` | `jobctl` |
| Python distribution `name` | `jobhunter` | `jobctl` *(owner-verify PyPI; §15.1)* |
| CLI invocation | `jobhunter <cmd>` / `uv … run jobhunter …` | `jobctl <cmd>` / `uv … run jobctl …` |
| Env var prefix | `JOBHUNTER_*` | `JOBCTL_*` |
| Vite env var | `VITE_JOBHUNTER_API_BASE_URL` | `VITE_JOBCTL_API_BASE_URL` |
| Data directory | `~/.jobhunter` | `~/.jobctl` |
| SQLite DB file | `jobhunter.db` | `jobctl.db` |
| DB backup filename | `jobhunter-<ts>.db` | `jobctl-<ts>.db` |
| Temporal task queue | `jobhunter-default` | `jobctl-default` |
| Temporal test task queue | `jobhunter-test` | `jobctl-test` |
| Temporal schedule id | `jobhunter-discovery-local` | `jobctl-discovery-local` |
| E2E state file | `.jobhunter-e2e-state.json` | `.jobctl-e2e-state.json` |
| Exported API client class | `JobHunterApiClient` | `JobCtlApiClient` |
| GitHub repo | `ebarti/JobHunter` | `ebarti/JobCtl` *(owner action; §15.2)* |

**Invariant — casing is meaningful.** The three case variants map
independently and must not bleed: `JobHunter` → `JobCtl` (note the capital
`C`), `jobhunter` → `jobctl`, `JOBHUNTER` → `JOBCTL`. A blind
case-insensitive substitution is forbidden — it would corrupt env var names,
identifiers, and prose casing. Each phase specifies which variant it touches.

---

## 2. Surface inventory (verified @ `a488e4e9`)

Files containing the name, by area (`rg -il jobhunter <area> | wc -l`):

| Area | Files | What lives here |
| --- | --- | --- |
| `workers/` | 393 | Python import package `src/jobhunter/`, CLI, Temporal, env-var reads, DB schema, MCP servers, tests |
| `apps/web/` | 217 | `@jobhunter/*` imports, `index.html` `<title>`, health strings, `JobHunterApiClient` usage, e2e state file, env vars |
| `docs/` | 63 | user/architecture/developer docs, VitePress config, screenshots; **21 are historical** (see §8 exceptions) |
| `apps/api/` | 41 | `@jobhunter/*` imports, `config.ts` data-dir + DB path, DB table names, env reads |
| `packages/` | 24 | 6 scoped package manifests + cross-package imports |
| `scripts/` | 4 | `dev` supervisor, `install`, `release_check.py`, docs-site checks |
| `.github/` | 1 | workflows (mostly reach the name via root `pnpm` scripts) |

### 2.1 pnpm packages (enumerated from every `package.json` `name`)

Seven manifests total: `package.json` (root, `name: "jobhunter"`, private
workspace root) plus six scoped packages —

| Package `name` | Path | Inbound refs (`@jobhunter/<x>` count) |
| --- | --- | --- |
| `@jobhunter/contracts` | `packages/contracts/package.json` | 149 |
| `@jobhunter/domain-types` | `packages/domain-types/package.json` | 132 |
| `@jobhunter/web` | `apps/web/package.json` | 74 |
| `@jobhunter/api-client` | `packages/api-client/package.json` | 28 |
| `@jobhunter/api` | `apps/api/package.json` | 14 |
| `@jobhunter/tsconfig` | `packages/tsconfig/package.json` | 11 |

All become `@jobctl/*`. Every `dependencies` / `devReferences`,
`tsconfig` `extends`, `pnpm --filter @jobhunter/<x>` script invocation, and TS
`import … from "@jobhunter/<x>"` follows.

### 2.2 Python distribution + CLI (`workers/automation/pyproject.toml`)

- `[project] name = "jobhunter"` (line 2) → distribution rename (§15.1).
- `[project.scripts] jobhunter = "jobhunter.cli:app"` (line 61) → `jobctl = "jobctl.cli:app"`.
- `[tool.hatch.build.targets.wheel] packages = ["src/jobhunter"]` (line 73) → `["src/jobctl"]`.
- `[tool.hatch.build] artifacts = ["src/jobhunter/config/*.yaml"]` (line 76) → `src/jobctl/config/*.yaml`.
- `[project.urls]` Homepage/Repository/Issues → new repo URL (§15.2).
- `[tool.pyright] extraPaths/include` reference `src`/`tests` (no name) — unaffected.
- Directory move: `workers/automation/src/jobhunter/` → `.../src/jobctl/` (393 files) and its 1820 intra-package import statements.

### 2.3 Environment variables (enumerated via `rg -o 'JOBHUNTER_[A-Z0-9_]+'`)

**65 distinct `JOBHUNTER_*` names** plus `VITE_JOBHUNTER_API_BASE_URL`. High-traffic examples (full set is grep-enumerable, do not hand-maintain a partial list in code): `JOBHUNTER_DIR` (29), `JOBHUNTER_RESUME_RENDERER` (18), `JOBHUNTER_TASK_QUEUE` (17), `JOBHUNTER_MAX_CONCURRENT_ACTIVITIES` (16), `JOBHUNTER_API_BASE_URL` (13), `JOBHUNTER_API_PORT` / `JOBHUNTER_API_HOST` (12 each), `JOBHUNTER_TEMPORAL_DB` (11), the `JOBHUNTER_E2E_*` family (7 names), `JOBHUNTER_GMAIL_*` (3), `JOBHUNTER_LINKEDIN_APPLY_*` (6), `JOBHUNTER_LEVELS_FYI_*` and `JOBHUNTER_GLASSDOOR_*` (source-registry families). All rename to `JOBCTL_*`; the constant identifier `JOBHUNTER_TASK_QUEUE` (`workers/automation/src/jobhunter/infrastructure/temporal/task_queues.py:7`) becomes `JOBCTL_TASK_QUEUE` **and** its value `"jobhunter-default"` → `"jobctl-default"` (§7).

### 2.4 Stateful / runtime identifiers (the non-textual surfaces)

These are not mere string swaps — they name persisted or server-side state and
require migration or cutover, not just find/replace:

- **Data directory** `~/.jobhunter` → `~/.jobctl`. Resolved in `apps/api/src/config.ts:13` (`env.JOBHUNTER_DIR || path.join(os.homedir(), ".jobhunter")`) and on the Python side via `JOBHUNTER_DIR`. Contains: `jobhunter.db` (+ `-wal`/`-shm`), `.env`, `gmail/`, `chrome-workers/`, `backups/`. **75** references to `.jobhunter` across the tree.
- **SQLite DB file** `jobhunter.db` (**158** refs; default at `apps/api/src/config.ts:25`, worker default under `JOBHUNTER_DIR`) → `jobctl.db`. Backup filename `f"jobhunter-{timestamp}.db"` (`workers/automation/src/jobhunter/database.py:128`) → `jobctl-…`.
- **DB table names** `jobhunter_deleted_jobs` (**90**) and `jobhunter_hidden_jobs` (**44**), created in `workers/automation/src/jobhunter/database.py:3358` and read cross-stack in `apps/api/src/read-model.ts` (many `tableExists`/JOIN sites), `scoring/scorer.py`, `pipeline/current_policy_selectors.py`. **Owner decision §15.3** — rename via migration vs keep as internal-schema exception.
- **Temporal task queue** `jobhunter-default` and test queue `jobhunter-test` — live in Temporal server state; the renamed worker only polls the new queue (§7).
- **Temporal schedule id** `f"jobhunter-discovery-{LOCAL_TENANT}"` = `jobhunter-discovery-local` (`workers/automation/src/jobhunter/cli.py:1398`; `LOCAL_TENANT = "local"` at `workers/automation/src/jobhunter/domain/tenant.py:13`) — a server-side Schedule object that must be deleted and recreated (§7). Workflow IDs themselves are already neutral (`discover-<tenant>`, `apply-<tenant>-<job>`) — **no change**.
- **Runtime string literals** carrying the name: `jobhunter-antigravity` runtime dir (`infrastructure/analysis/antigravity_analysis_adapter.py:59`), `jobhunter-gmail` MCP `serverInfo.name` (`infrastructure/gmail/mcp_server.py:44`), and artifact/cache id prefixes `jobhunter-profile-preview-`, `jobhunter-posted-compensation-`, `jobhunter-pdf-preview-`.

### 2.5 UI, docs-site, and screenshots

- `apps/web/index.html:7` `<title>JobHunter</title>`.
- Worker-health copy: `apps/web/src/shared/layout/ConnectionStatusPill.tsx:43` and matching API-produced messages ("JobHunter automation worker …").
- Exported class `JobHunterApiClient` in `@jobhunter/api-client` (public symbol used at `apps/web/src/shared/adapters/local/FetchApiClientAdapter.ts`).
- VitePress config `docs/.vitepress/config.ts`: `title: "JobHunter"` (:171), `REPO_URL` (:5), footer copyright (:215).
- **8 synthetic product screenshots** in `docs/assets/screenshots/` (`dashboard.png`, `discovery.png`, `jobs.png`, `job-detail.png`, `pipelines.png`, `runs.png`, `apply-review.png`, `profile.png`) — rendered from the running web app by `apps/web/e2e/tests/docs-screenshots.spec.ts` (invoked via `pnpm docs:screenshots`). Any that show the old browser-tab title or in-app branding must be **regenerated after the UI rename**, not hand-edited.

---

## 3. Critical ordering constraint and mandatory preflight

**The rename runs LAST, immediately before publication.** It rewrites path and
symbol anchors that in-flight specs depend on. The active spec
`docs/plans/2026-07-03-oss-release-remediation-spec.md` contains **24** lines
that anchor to old-name paths/symbols (e.g.
`workers/automation/src/jobhunter/apply/prompt.py`,
`workers/automation/src/jobhunter/infrastructure/apply_tools/mcp_server.py`,
`@jobhunter/web`, `JOBHUNTER_API_ALLOW_REMOTE_BIND`). Running the rename while
that spec is still being implemented would invalidate every one of those
anchors mid-flight — exactly the failure the "machine-verify spec anchors
before handoff" discipline exists to prevent.

### 3.1 Preflight gate (all must hold before cutting the first rename branch)

- [ ] **No open spec is still anchored to old-name paths.** The only active
      top-level plan is the OSS remediation spec (verified: `ls docs/plans/*.md`
      shows only it and `README.md`). It must be **fully delivered** and moved
      to `docs/plans/implemented/` (per `docs/plans/README.md`), OR the owner
      explicitly authorizes re-anchoring any residual open spec to new paths as
      part of this train. Re-run `ls docs/plans/*.md` and
      `rg -l --pcre2 'jobhunter' docs/plans/*.md` at execution time: any
      non-`README.md` hit is a STOP.
- [ ] **The temporal-native rearchitecture program is merged** (its P1b–P5
      items own `cli.py`, `pipeline/actions.py`, `discovery/**`,
      `infrastructure/temporal/**` — the exact files this rename moves). Cutting
      the rename before they land guarantees conflicts on the moved package.
- [ ] **Working tree clean, `main` up to date**, worktree cut fresh from
      `origin/main` (per `CLAUDE.md` worktree rules).
- [ ] **No running JobHunter workflows** that must survive the cutover, or an
      explicit drain/terminate plan per §7 is scheduled.
- [ ] Re-derive the footprint (§0 table) at execution HEAD; if counts have
      moved materially, re-verify the anchor tables in §2 before proceeding.

If any box fails, STOP and report rather than proceeding.

---

## 4. Execution strategy — one atomic train

The rename is **atomic**: the tree is either fully JobHunter or fully JobCtl;
no intermediate commit on `main` may leave a half-renamed, non-building tree.
Two equally acceptable shapes — the implementer chooses and records the choice:

- **Single-PR shape.** One branch `docs/plan-rename-jobctl`… (implementation
  branch, e.g. `chore/rename-jobctl`), all phases in one reviewable PR. Simplest
  to keep atomic; largest diff.
- **Stacked-train shape.** Phases R1–R10 as stacked PRs (each branch cut from
  the previous), reviewed independently, **merged as one train** in a single
  sitting so `main` never sits half-renamed between merges. Prefer this only if
  reviewers can turn the stack around in one window; use the merge-train
  mechanics in the repo's standing guidance (retarget-before-merge).

Either way the **whole-tree grep gate (§8) and full cross-stack verification
(§9) must pass on the final state before any merge to `main`.** Because this is
the last change before publication, there is no "fix forward on main" — a red
gate blocks the train.

Phase dependency (topological; within the train):

```
R1 pnpm packages ─┐
R2 python pkg/CLI ─┼─► R3 env vars ─► R4 data-dir + DB (+ R-migration) ─┐
                   │                                                     ├─► R8 grep gate
R5 temporal ids ───┘                                                     │   + R9 verify
R6 dev/scripts ─────────────────────────────────────────────────────────┤   + R10 QA
R7 UI + docs + screenshots ──────────────────────────────────────────────┘
```

---

## 5. Phases

Each phase lists: **Objective**, the **case variant(s)** it touches, **surface**
(verified anchors), **invariants**, and phase-local **done** criteria. None
prescribes exact edits.

### R1 — pnpm workspace rename (`@jobhunter/*` → `@jobctl/*`)

- **Variants:** `jobhunter` (lowercase, in scoped names) + `JobHunter` (only the `JobHunterApiClient` symbol, deferred to R7 if preferred; keep consistent).
- **Surface:** the 7 `package.json` `name` fields (§2.1); all inbound `@jobhunter/*` refs (408); `pnpm --filter @jobhunter/*` invocations in root `package.json` scripts (`check`, `test`, `api:*`, `web:*`, `qa:test`, `docs:screenshots`) and in `scripts/dev` (lines 37–38); `tsconfig` `extends: "@jobhunter/tsconfig"`; `pnpm-lock.yaml` regeneration.
- **Invariants:** workspace resolves after rename (`pnpm install` clean, no unresolved `@jobhunter/*`); no scoped package keeps the old name; lockfile regenerated deterministically.
- **Done:** `pnpm install` clean; `pnpm check` passes; zero `@jobhunter/` in tracked files outside §8 exceptions.

### R2 — Python package + CLI + distribution

- **Variants:** `jobhunter` (import package, dotted module paths, console script) + distribution name.
- **Surface:** move `workers/automation/src/jobhunter/` → `src/jobctl/`; rewrite all 1820 `from jobhunter…`/`import jobhunter…` lines to `jobctl`; `pyproject.toml` (§2.2); every `uv --project workers/automation run jobhunter …` invocation in docs, `scripts/dev:39`, `scripts/install`, CI; test imports across `workers/automation/tests/` (171 files reference the name).
- **Invariants:** the package imports under exactly one name (`jobctl`); the console script is `jobctl`; `python -m build` produces the renamed sdist/wheel; no dotted `jobhunter.` module path survives; CLI `jobctl --help` and `jobctl doctor` run.
- **Done:** `uv --project workers/automation run --extra dev pytest -q` 100% pass; `ruff check .` clean; `python -m build workers/automation` builds clean; `uv … run jobctl doctor` runs.

### R3 — Environment variables (`JOBHUNTER_*` → `JOBCTL_*`)

- **Variants:** `JOBHUNTER` (uppercase) + the `VITE_JOBHUNTER_*` case.
- **Surface:** all 65 distinct `JOBHUNTER_*` names + `VITE_JOBHUNTER_API_BASE_URL`, in Python reads, `apps/api/src/config.ts`, `apps/web` (`import.meta.env`), `scripts/dev`, `scripts/install`, `.env.example` (15 refs), all docs tables (`docs/user/configuration.md` especially), test env plumbing, `apps/web/e2e` fixtures.
- **Invariants:** **clean break** — the code reads only `JOBCTL_*`; no dual-read fallback to `JOBHUNTER_*` (rip-and-replace). The `.env.example` and `docs/user/configuration.md` var table are exhaustive and match the code. Constant identifiers holding queue/schedule strings are handled in R5/R7, not here.
- **Done:** zero `JOBHUNTER_` in tracked files outside §8 exceptions; `pnpm check` + Python tests green; `.env.example` uses only `JOBCTL_*`.

### R4 — Data directory, DB file, and first-run migration

The stateful centerpiece. See §6 for the full acceptance-template treatment.

- **Surface:** default dir resolution (`apps/api/src/config.ts:13,25` + Python `JOBHUNTER_DIR` resolver); DB filename `jobhunter.db` → `jobctl.db` (158 refs, but most are the constant/default — locate the single owning default and the test fixtures); backup filename (`database.py:128`); the E2E state file `.jobhunter-e2e-state.json` (`apps/web/e2e/fixtures/global-setup.ts:28`, `global-teardown.ts:28`, `tests/dry-run.spec.ts:26`); DB table names per §15.3.
- **Invariants:** a fresh install writes only `~/.jobctl`; an existing `~/.jobhunter` is **moved once** (not copied) to `~/.jobctl` on first renamed-process start; the move is idempotent and refuses to clobber a pre-existing `~/.jobctl`; no data loss; DB opens and read model is intact after migration.
- **Done:** migration fixture (§6, §10) green; boot on a synthetic migrated workspace (§11) shows intact jobs/events/projections.

### R5 — Temporal task queue and schedule identifiers

- **Surface:** `task_queues.py:7` (`JOBHUNTER_TASK_QUEUE` const name + `"jobhunter-default"` value); the `jobhunter-test` queue in test setup; `schedule_id = f"jobhunter-discovery-{LOCAL_TENANT}"` (`cli.py:1398`); worker registration (`infrastructure/temporal/worker.py:60,74`); any API-side task-queue string.
- **Invariants:** worker registers and polls only `jobctl-default`; the discovery schedule reconciles under `jobctl-discovery-local`; the cutover runbook (§7) drains/terminates old-queue work and deletes the old schedule so no orphan remains.
- **Done:** worker boots on `jobctl-default`; `jobctl` CLI schedule reconcile creates `jobctl-discovery-local` (schedule stays disabled by default per README); §7 runbook executed.

### R6 — Dev supervisor and scripts

- **Surface:** `scripts/dev` (header comment line 2; component runners lines 36–39; env exports lines 160,170–176; `$HOME/.jobhunter/.env` and `$HOME/Jobhunter/.env` fallbacks line 160; `.dev` tracking dir is name-neutral — leave it); `scripts/install` (`~/.jobhunter/.env` hint line 217); `scripts/release_check.py` (its structural check references the PyPI-blocked distribution name and `publish.yml` — reconcile with §9.3); `scripts/check-docs-site-*.mjs` (name-neutral, verify).
- **Invariants:** `pnpm dev` / `pnpm dev:start` bring up all four components (temporal, api, web, worker) under new package filters, new env vars, and the `jobctl` worker command; the `.env` search path points at `~/.jobctl`.
- **Done:** `pnpm dev` boots the stack (manual QA §11); no `jobhunter` literal in `scripts/dev` or `scripts/install` outside intended exceptions.

### R7 — UI branding, exported symbols, docs, docs-site, screenshots

- **Variants:** `JobHunter` (PascalCase, prose + symbols).
- **Surface:** `apps/web/index.html:7` title; worker-health copy (`ConnectionStatusPill.tsx:43` + API message source + web fixtures/tests asserting the string); exported class `JobHunterApiClient` → `JobCtlApiClient` (definition in `packages/api-client` + all usages); VitePress `title`/`REPO_URL`/copyright (`docs/.vitepress/config.ts:5,171,215`); all published docs prose (`README.md` title line 1 + body; `docs/user/**`, `docs/architecture/**`, `docs/developer/**`, `docs/decisions.md`, `SECURITY.md` (2), `CONTRIBUTING.md` (4)); the 8 screenshots regenerated via `pnpm docs:screenshots` **after** the UI title changes.
- **Invariants:** no shipping UI string, doc page, or screenshot shows "JobHunter"; the exported public symbol name is renamed (clean break, no alias export); `pnpm docs:build` succeeds and its dead-link check passes (note: `docs/plans/**` and `docs/incidents/**` are `srcExclude`d per `docs/.vitepress/config.ts:174`, so this plan is not built into the site).
- **Done:** `pnpm web:check` + `pnpm web:build` + web unit tests green; `pnpm docs:build` green; screenshots regenerated and free of the old name; grep gate §8 clean over `docs/**` (minus exceptions), `README.md`, `apps/web/index.html`.

### R8 — Grep gate (see §8) · R9 — Verification (see §9) · R10 — QA (see §11)

These three run on the assembled final state and gate the merge/train.

---

## 6. Data-directory migration (acceptance-template treatment)

Per `CLAUDE.md` auditability discipline, the one stateful invariant answered
against the repo's acceptance template:

- **Product invariant:** a returning user's existing local workspace and all
  its data (profile, jobs, events, projections, generated-materials metadata,
  `.env`, Gmail auth, browser worker state, backups) survive the rename with
  zero loss and appear under the new `~/.jobctl` path after a single automatic,
  in-place move.
- **Source of truth:** the on-disk workspace directory (default `~/.jobhunter`),
  containing `jobhunter.db` (+ `-wal`/`-shm`), `.env`, `gmail/`,
  `chrome-workers/`, `backups/`.
- **Bounded context / owning writer:** directory resolution is owned in
  `apps/api/src/config.ts` (TS) and the Python config layer keyed on
  `JOBHUNTER_DIR`. The migration MUST live at a **single** first-run bootstrap
  entry point (recommended: the Python `doctor`/`init` path and/or the shared
  config bootstrap both stacks call), not scattered across call sites. Locate
  the owning writer; do not sprinkle move logic.
- **Projection / read model:** the DB feeding `apps/api/src/read-model.ts` —
  including the `jobhunter_deleted_jobs` / `jobhunter_hidden_jobs` tables
  (§15.3) — must open and return identical rows post-migration.
- **UI surface making it inspectable:** the migration emits a clear one-time
  log/notice ("migrated ~/.jobhunter → ~/.jobctl") surfaced in `doctor` output
  and the dev supervisor startup log, so the user can confirm it happened.
- **User action approving automation:** none required (single-user, local,
  non-destructive move); but the move is **guarded** — it aborts rather than
  overwrite if `~/.jobctl` already exists, and logs the manual step in that
  case. `JOBCTL_DIR`, if set, wins over both defaults and suppresses the move.
- **Synthetic regression fixture (§10):** proves the invariant from canonical
  state, not a snapshot.
- **Local QA path (§11):** exercises the real first-run migration on a
  synthetic HOME.

**Migration behavior contract:**
1. If `JOBCTL_DIR` (or explicit override) is set → use it; no move.
2. Else if `~/.jobctl` exists → use it; no move (idempotent second run).
3. Else if `~/.jobhunter` exists → **move** (rename) it to `~/.jobctl`
   atomically where the filesystem allows; if a cross-device rename is needed,
   copy-then-verify-then-remove, and never delete the source until the copy is
   verified. Then, if §15.3 = rename-tables, run the `ALTER TABLE … RENAME TO`
   inside the same first-run migration transaction, and rename the DB file
   `jobhunter.db` → `jobctl.db`.
4. Else → fresh `~/.jobctl`.
5. The migration is safe to attempt from either stack; a lock or check-and-set
   prevents a double move when API and worker start concurrently.

---

## 7. Temporal cutover runbook

Task-queue and schedule identifiers are server-side state in the local Temporal
dev server; a pure code rename orphans in-flight work. Because this is a
single-user local deployment (Temporal dev server backed by the SQLite file at
`JOBHUNTER_TASK_QUEUE`'s sibling `JOBHUNTER_TEMPORAL_DB`), the safe cutover is:

1. **Before cutover:** stop starting new work. Let in-flight workflows drain to
   completion, OR terminate them deliberately (owner's call; single-user, so
   loss of an in-flight discovery/apply run is acceptable if the owner accepts
   it). Record which was chosen.
2. **Delete the old schedule** `jobhunter-discovery-local` (the reconcile logic
   in `cli.py` will not delete a schedule under the old id once the code emits
   the new id). A one-time `temporal schedule delete --schedule-id
   jobhunter-discovery-local` (or the equivalent client call) removes it.
3. **Deploy renamed code.** The worker now registers `jobctl-default`; the CLI
   reconciles `jobctl-discovery-local` (disabled by default — README states the
   schedule is off until the user enables it, so no cron fires unbidden).
4. **Verify** no workflow remains pinned to `jobhunter-default` and no schedule
   `jobhunter-discovery-local` remains (`temporal workflow list`,
   `temporal schedule list`).
5. Because the dev-server DB is disposable local state, an accepted simpler
   alternative for a clean owner environment is to **reset the Temporal dev
   server state** (fresh `JOBCTL_TEMPORAL_DB`), eliminating orphans entirely.
   Flag as owner preference (§15.4).

The renamed test task queue `jobctl-test` is created fresh by the test harness;
no server-side migration needed there.

---

## 8. Grep gate (Definition of Done — zero old-name in shipping surfaces)

Two gates. Both run in R8 and in CI (extend `scripts/release_check.py` or add a
dedicated name-gate check; the OSS spec's privacy CI pattern in
`.github/workflows/release-check.yml` is the model).

**Gate A — public product surfaces, MUST be exactly zero (any case):**

```
rg -i 'jobhunter' \
  README.md SECURITY.md CONTRIBUTING.md .env.example \
  apps/web/index.html \
  docs/assets/screenshots/ \
  --glob '!docs/plans/**' --glob '!docs/incidents/**'
rg -i 'jobhunter' docs/ \
  --glob '!docs/plans/**' --glob '!docs/incidents/**' --glob '!docs/backlog.md'
# package metadata
rg -i 'jobhunter' package.json apps/*/package.json packages/*/package.json \
  workers/automation/pyproject.toml
# CLI help text (runtime): `jobctl --help` and every subcommand help emit no "jobhunter"
```

**Gate B — whole tree, zero except the justified allowlist:**

```
rg -i 'jobhunter' \
  --glob '!docs/plans/implemented/**' \
  --glob '!docs/incidents/**' \
  --glob '!docs/plans/README.md' \
  --glob '!docs/plans/2026-07-05-rename-jobctl-plan.md' \
  --glob '!scripts/release_check.py'
# expected: no output
```

**Justified exceptions (why each is allowed to retain the old name):**

- `docs/plans/implemented/**` (20 files) and `docs/incidents/**` (1 file) —
  **historical records** of work delivered under the old name; rewriting them
  would falsify history. They are `srcExclude`d from the published site
  (`docs/.vitepress/config.ts:174`), so no reader-facing page shows the name.
- `docs/plans/README.md` — the historical **spec ledger**; its rows name plans
  by their delivered title. It is also `srcExclude`d.
- `docs/plans/2026-07-05-rename-jobctl-plan.md` — **this plan**, which must name
  the old product to describe the rename. `srcExclude`d.
- `scripts/release_check.py` — the privacy scanner may legitimately carry the
  string inside its (obfuscated) needle machinery; it already excludes itself
  from scanning. If the name-gate is added here, it excludes itself too.
- **Git history** — out of scope by owner decision (history is kept, per OSS
  spec §1); the gate scans the working tree only.

Any hit outside this allowlist is a **blocker**. If a new legitimate exception
is discovered during execution, it must be added here with a one-line
justification in the PR, not silently `--glob`'d away.

---

## 9. Verification matrix (exact commands per touched surface)

Run per `CLAUDE.md` "Build, Test, And Lint Commands"; the full sweep before the
train merges. All must pass on the final renamed state.

| Surface | Command | Required result |
| --- | --- | --- |
| Workspace resolves | `pnpm install` | clean, no unresolved `@jobhunter/*` |
| Full typecheck/lint | `pnpm check` | zero errors |
| Full test sweep | `pnpm test` | all pass |
| API typecheck | `pnpm api:check` | zero errors |
| API tests | `pnpm api:test` | all pass |
| API QA harness | `pnpm qa:test` | all pass |
| Web typecheck | `pnpm web:check` | zero errors |
| Web build | `pnpm web:build` | builds clean |
| Web unit/hook/component | `pnpm --filter @jobctl/web test` | all pass |
| Web type-level | `pnpm --filter @jobctl/web test-d` | all pass |
| Python tests | `uv --project workers/automation run --extra dev pytest -q` | 100% pass |
| Python lint | `uv --project workers/automation run --extra dev ruff check .` | `All checks passed!` |
| Python package build | `uv --project workers/automation run --extra dev python -m build workers/automation` | renamed sdist/wheel, builds clean |
| Docs site build + dead links | `pnpm docs:build` | builds; link check passes |
| Docs runtime check | `pnpm docs:check:runtime` | passes |
| Grep gate A + B | commands in §8 | zero (minus allowlist) |
| Hygiene | `git diff --check` | clean |

### 9.1 Boot verification (the rename must not just typecheck — it must run)

- `uv --project workers/automation run jobctl doctor` — clean, expected warnings only.
- `uv --project workers/automation run jobctl worker` — registers on `jobctl-default`, health endpoint green.
- `pnpm api:dev` (or `pnpm dev`) — API binds, `/v1/health` reports the worker healthy under new names.
- `pnpm web:dev` (or `pnpm dev`) — web loads, tab title reads "JobCtl", connection pill healthy.

### 9.2 E2E

- `pnpm --filter @jobctl/web e2e` — Playwright specs pass with the renamed
  state file `.jobctl-e2e-state.json` and renamed env fixtures.

### 9.3 Privacy/structural scanner reconciliation

`scripts/release_check.py` has a structural check tied to the "PyPI-blocked
distribution name" and `publish.yml`'s tag trigger (OSS spec §W0.3 item 7 /
§W2.1). Since this plan performs the distribution rename that check was
guarding, update the check to expect the new distribution name and re-enable
the `publish.yml` tag trigger **as the final step of the train** (mirrors OSS
spec §W2.1 item 3). `python3 scripts/release_check.py` must exit 0 on the final
tree.

---

## 10. Required regression fixtures

Do not claim "renamed" without these. Each proves an invariant from canonical
state.

1. **Data-dir migration fixture** (Python, `workers/automation/tests/`):
   build a synthetic `~/.jobhunter`-shaped workspace under a temp HOME
   containing a real (seeded) SQLite DB, a `.env`, and `gmail/`/`backups/`
   subdirs; run the first-run bootstrap; assert (a) `~/.jobctl` now holds all
   files, (b) source dir is gone, (c) the DB opens and row counts match, (d) a
   second run is a no-op, (e) a pre-existing `~/.jobctl` is **not** clobbered
   (abort + notice), (f) `JOBCTL_DIR` override suppresses the move.
2. **DB read-model parity fixture** (if §15.3 = rename-tables): seed the two
   tombstone/hidden tables under the old names, run the table migration, assert
   the TS read-model queries (`apps/api/test/`) return identical
   deleted/hidden filtering against the new table names.
3. **Env-var exhaustiveness test:** assert no `JOBHUNTER_*` remains in code
   reads and that `.env.example` ∪ `docs/user/configuration.md` covers exactly
   the `JOBCTL_*` names the code reads (extends any existing config-parity
   test; the repo already has `scripts/check-domain-type-parity.py` as a parity
   pattern).
4. **Name-gate self-check:** a test that Gate B (§8) returns empty on the
   renamed tree and non-empty when a synthetic `jobhunter` token is injected
   into a scanned path (models the OSS spec's `release_check` self-test).
5. **Temporal identifier test:** assert the task-queue constant resolves to
   `jobctl-default` and the schedule id builder yields `jobctl-discovery-local`.

---

## 11. Product-path QA checklist (real flows, not just unit tests)

Run on a **synthetic** workspace (never the owner's real `~/.jobhunter`; use a
throwaway `JOBCTL_DIR`/HOME per the isolated-QA recipe). No real applications,
no spendful runs.

- [ ] **Migration QA:** seed a synthetic `~/.jobhunter` (copy a disposable
      seeded DB in), start the renamed stack once, confirm the one-time
      migration notice, confirm `~/.jobctl` holds the data and the app shows the
      pre-existing jobs/events.
- [ ] **Fresh-install QA:** with no prior dir, start the stack; confirm only
      `~/.jobctl` is created and onboarding works.
- [ ] **Boot QA:** `jobctl doctor` clean; worker on `jobctl-default`; API
      `/v1/health` green; web tab title "JobCtl"; connection pill healthy.
- [ ] **Discovery QA:** trigger a (stubbed/synthetic) discovery; confirm the
      schedule reconciles under `jobctl-discovery-local` and stays disabled by
      default.
- [ ] **Read-model QA:** delete/hide a job; confirm the tombstone/hidden
      filtering still works (exercises the renamed or retained tables §15.3).
- [ ] **Docs QA:** `pnpm docs:build`; spot-check the rendered site and the 8
      screenshots show "JobCtl", never the old name.
- [ ] Any UI/UX regression the human finds becomes a QA regression test or a
      documented checklist item before done (per `CLAUDE.md`).

---

## 12. Definition of Done

- [ ] Preflight (§3) satisfied and recorded.
- [ ] Name map (§1) applied across all surfaces (§2), casing-correct.
- [ ] Grep Gate A **and** Gate B (§8) return zero outside the justified
      allowlist; CI name-gate added and green.
- [ ] Full verification matrix (§9) green, including `pnpm check`, `pnpm test`,
      Python `pytest` + `ruff`, `python -m build`, and `pnpm docs:build`.
- [ ] Boot verification (§9.1) green: `jobctl` CLI, worker, API, web all run
      under the new names.
- [ ] Data-dir migration QA'd on a synthetic workspace (§11); migration +
      parity + env + name-gate + temporal-id fixtures (§10) green.
- [ ] Temporal cutover (§7) executed: no orphan `jobhunter-default` work, no
      `jobhunter-discovery-local` schedule.
- [ ] Docs updated per `CLAUDE.md` doc matrix (README, docs/user, docs/architecture,
      package.json, pyproject.toml) and screenshots regenerated.
- [ ] `publish.yml` tag trigger re-enabled and `release_check.py` structural
      check updated to the new distribution name (§9.3), gated on the privacy
      workflow.
- [ ] Owner decisions §15 resolved and recorded.
- [ ] Review gate `Gate: PASS` and QA gate `Gate: PASS` per repo process; no
      open Blocker/High findings.

---

## 13. Non-goals

- **No compatibility layer.** No `JOBHUNTER_*` fallback reads, no
  `@jobhunter/*` alias packages, no `jobhunter` console-script alias, no
  symlink `~/.jobhunter → ~/.jobctl`. Clean break (single-user; owner
  authorized).
- **No git-history rewrite.** History keeps the old name (consistent with OSS
  spec §1); the working-tree gate does not scan history.
- **No behavior change.** This is a rename only — no feature, schema-semantics,
  workflow, or API-contract changes beyond identifier strings and the one-time
  data move. Renaming DB tables (§15.3) is identifier-only, not a semantics
  change.
- **No new capabilities or docs beyond what the rename requires.** Update the
  owning docs; do not add new documents.
- **Not a substitute for the OSS remediation spec's W-items** — those must land
  first (§3); this plan only supersedes that spec's naming decision and §W2.1.

---

## 14. Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Case-insensitive bulk replace corrupts env vars/prose | Broken config, ugly prose | Per-variant phased replace (§1 invariant); grep gate distinguishes case; review diff |
| Half-renamed `main` between stacked merges | Non-building `main` at publication | Atomic train (§4): whole-tree gate + full verify before any merge; single-PR shape if the train can't merge in one window |
| Data-dir move loses or clobbers data | User data loss | Guarded move: never overwrite existing `~/.jobctl`, verify-before-remove on cross-device copy, idempotent, fixture-proven (§6, §10.1) |
| Orphaned Temporal workflows/schedule on old queue | Stuck/invisible runs | Cutover runbook (§7): drain/terminate + delete old schedule; verify no orphans; optional dev-server reset |
| Open spec anchors invalidated mid-flight | Broken in-flight implementations | Preflight gate (§3): rename runs last, after OSS spec delivered/re-anchored |
| DB table rename cross-stack mismatch (Py writes, TS reads) | Read model breaks | Rename in one migration + coordinated Py+TS change + parity fixture (§10.2); or keep tables (§15.3 fallback) |
| Screenshots retain old tab title/branding | Old name leaks to published site | Regenerate via `pnpm docs:screenshots` after UI rename; grep gate scans `docs/assets/screenshots/` names + QA visual check |
| PyPI `jobctl` unavailable | Can't publish under `jobctl` dist name | Owner-verify + fallback distribution name while import/CLI stay `jobctl` (§15.1) |
| GitHub repo rename breaks hardcoded URLs | Dead links | Update all `github.com/ebarti/JobHunter` refs; GitHub preserves redirects; owner performs rename (§15.2) |

---

## 15. Open owner decisions (STOP and confirm)

1. **PyPI distribution name.** Target is `jobctl`. Confirm availability
   (`https://pypi.org/pypi/jobctl/json` → 404 = free) and a quick GitHub/USPTO
   sanity check, mirroring the OSS spec §W2.1 checkpoint. If taken, pick a
   distribution name while the **import package and console script remain
   `jobctl`** regardless (the two may differ, as the OSS spec already
   anticipated). This checkpoint replaces OSS spec §0.5.1.
2. **GitHub repository rename.** Rename `ebarti/JobHunter` → `ebarti/JobCtl`
   (owner-only action; GitHub preserves redirects). Confirm the final
   owner/repo slug so all `REPO_URL` / `[project.urls]` / doc references can be
   updated to match. Owner executes the rename; the implementer updates the
   in-repo URLs.
3. **DB table names.** `jobhunter_deleted_jobs` / `jobhunter_hidden_jobs`:
   **(a) rename** to `jobctl_*` via `ALTER TABLE … RENAME TO` folded into the
   first-run migration (recommended — clean OSS surface; the migration already
   touches the DB) **or (b) keep** as internal-schema identifiers (justified
   grep exception; lower migration risk). Default recommendation: (a).
4. **Temporal cutover style.** Drain-in-flight vs terminate-in-flight vs full
   dev-server reset (§7). Default: terminate/drain then delete old schedule;
   reset acceptable in a clean owner environment.
5. **Execution shape.** Single-PR vs stacked-train (§4). Default: whichever
   keeps `main` atomic given reviewer availability.

---

## 16. Anchor appendix (verified @ `a488e4e9`)

Key file:line anchors an implementer will need first (re-verify by symbol at
execution HEAD, per repo discipline — line numbers drift):

- `package.json` root name + `pnpm --filter @jobhunter/*` scripts (lines 21–47).
- `apps/api/package.json`, `apps/web/package.json`,
  `packages/{contracts,domain-types,api-client,tsconfig}/package.json` — `name`.
- `workers/automation/pyproject.toml:2,61,64-66,73,76`.
- `apps/api/src/config.ts:13,25` — data dir + DB default.
- `workers/automation/src/jobhunter/database.py:128,3358` — backup name, table DDL.
- `workers/automation/src/jobhunter/infrastructure/temporal/task_queues.py:7` — queue constant + value.
- `workers/automation/src/jobhunter/cli.py:1398` — schedule id.
- `workers/automation/src/jobhunter/domain/tenant.py:13` — `LOCAL_TENANT`.
- `apps/web/index.html:7` — tab title.
- `apps/web/src/shared/layout/ConnectionStatusPill.tsx:43` — health copy.
- `docs/.vitepress/config.ts:5,171,174,215` — REPO_URL, title, srcExclude, copyright.
- `.github/workflows/docs-site.yml:77` — pre-existing `jobctl-docs` CF project.
- `scripts/dev:2,36-39,160,170-176`; `scripts/install:217`.
- `apps/web/e2e/fixtures/global-setup.ts:28`, `global-teardown.ts:28`,
  `tests/dry-run.spec.ts:26` — `.jobhunter-e2e-state.json`.
- Historical exception surfaces: `docs/plans/implemented/**` (20 files),
  `docs/incidents/**` (1 file), `docs/plans/README.md`.
</content>
