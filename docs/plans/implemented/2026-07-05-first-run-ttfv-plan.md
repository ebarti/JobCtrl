# First-Run Time-to-Value: Real-Path Measurement Discipline

- **Date:** 2026-07-05
- **Status:** Implemented / archived 2026-07-08. Delivered by #259 (plan) and #343 (real-path measurement harness, probes, QA entry, and packaging-decision ADR scaffold). Goal B was withdrawn by owner decision and #330 was closed unmerged; the desktop-packaging verdict remains pending owner-run TTFV evidence in `docs/decisions.md`.
- **Anchors verified against main @ a488e4e9.** Every path, symbol, command, and fixture cited below was checked against this worktree's HEAD. Per repo practice, machine-re-verify every anchor against the implementation base ref before handing any phase to an implementer. Content attributed to PR #254 is cited by PR number only; that plan is not yet on `main`.
- **Owner-facing goal:** make the first ten and thirty minutes of a fresh JobCtrl install *provably* valuable on the real product path, measure that value on clean environments as an owner-run regression discipline, and define — with evidence, not guesswork — when a packaged desktop install becomes worth building.

---

## ⚠ Owner amendment 2026-07-06 (supersedes conflicting text below)

The owner ruled: **"Using synthetic data is lying."** Applied to this plan:

1. **Goal B is withdrawn in its entirety.** There is no synthetic sample
   dataset, no "Load sample data" surface, and no sample-backed probe. The
   implementation PR that delivered Goal B (#330) is closed unmerged.
2. **TTFV is measured on the real path only.** The published time-to-value
   number comes from a clean-machine run with real vendor auth and a real job
   posting scored by real models. Whatever honest number that produces is the
   number that gets published. No synthetic-path timing may back any public
   claim. (Companion rule recorded in the launch-readiness plan §11.6:
   synthetic data may *illustrate* — captioned screenshots — but never
   *measure*.)
3. **Measurement gate (Goal A, as decided):** reference environment = the
   owner's Apple-silicon macOS machine; pass statistic = median of 3 clean
   runs under threshold with the worst run under 1.5× threshold; cadence =
   pre-release only (plus one baseline run now for the QA matrix). Real LLM
   spend is expected and accepted for these owner-run measurements; they never
   run unattended or in CI.
4. **Goal C (packaging decision) is unchanged** — the agent prepares the
   decision artifact with measured inputs; the decision itself is the owner's.

Sections below marked "Goal B" and every reference to a synthetic-path TTFV
gate are retained for historical context only and are void.

---

## 0. Context and scope boundary

Today JobCtrl installs from source. `docs/user/getting-started.md:9` states plainly that "there is no packaged installer yet, so setup is developer-shaped," and estimates "roughly 15–30 minutes end to end, mostly downloads" for the toolchain alone (`docs/user/getting-started.md:27-31`). The documented path is `pnpm install:interactive` (→ `scripts/install`, `package.json:13`), then `jobctrl init` + `jobctrl doctor` (`docs/user/getting-started.md:86-96`), then `pnpm dev` (→ `scripts/dev`, `package.json:12`). Value only appears after a real Discover run (`discover → enrich → score → tailor → cover`, `docs/user/normal-flows.md`) that needs LLM auth and network access to job sources.

**This plan is the measurement-and-demonstration layer that sits on top of the install/auth foundation. It builds on, and never re-specifies, the low-friction install plan (PR #254).** PR #254 owns: the one-command bootstrap (`scripts/install.sh` → a new `jobctrl setup` command), per-leg ensemble auth detection/enrollment, the extended `doctor` ensemble checks (its S1, aligning with OSS spec §W2.6), leg enable/disable config (its S4), and the glibc-Linux Codex wheel-gap remediation (its S5). This plan assumes that foundation and adds only what PR #254 explicitly does not cover:

| This plan owns | PR #254 owns (do not duplicate) |
|---|---|
| A measured definition of first-run *value* and wall-clock budgets for reaching it | The mechanics of installing and authenticating the stack |
| The clean-environment measurement protocol and its recurring entry in the QA matrix | `doctor`/`setup` per-leg auth truthfulness |
| Real-path measurement records and stop-condition probes | The dependency sync, toolchain, and vendor-binary bundling stance |
| The evidence-based decision framework for whether to build a packaged desktop install | The documented platform coverage and the Linux wheel-gap remediation (an *input* to this plan's packaging decision) |

Non-negotiable inheritances from PR #254 that constrain this plan: **no vendor binaries are redistributed in any JobCtrl artifact** (the Claude Code CLI is proprietary/no-redistribution; the Codex and Antigravity binaries arrive only as pinned PyPI wheels). This directly bounds what any future package (§3) may contain.

Three goals follow, each with objectives, invariants, explicit acceptance gates, and verification.

---

## 1. Goal A — Time-to-first-value as a QA discipline

**Objective.** Define time-to-first-value (TTFV) as two measurable metrics with hard budgets, a reproducible clean-environment protocol for measuring them, and recurring regression entries in `docs/local-reliability-qa.md` so a setup regression that pushes first value past budget fails a named check instead of being discovered by a frustrated new user.

### 1.1 The two metrics and their thresholds

| ID | Metric | Threshold (reference environment) | Value proven |
|---|---|---|---|
| **TTFV-1** | Clean environment → **first scored job observable** | **≤ 10 minutes** | The triage half of the product works: a job carries a fit score with auditable evidence and renders in the read model. |
| **TTFV-2** | Clean environment → **first reviewed tailored resume PDF** | **≤ 30 minutes** | The materials half works: a tailored resume PDF is viewable and reviewable in Apply Review. |

Synthetic data is not permitted for either metric. The only gateable
measurement mode is the owner-run real path: real vendor auth, one real
discovery target, a real job discovered after T0, real model scoring, and a real
tailored resume PDF. The wrapper and probes may be dry-validated without spend,
but dry/probe records are not gateable TTFV evidence.

### 1.2 Start and stop timestamps (must be machine-checkable, not subjective)

- **T0 (start), both metrics:** the instant the first documented install command runs in a clean environment (the first command of the install path — today `pnpm install:interactive`, under PR #254 the `scripts/install.sh` bootstrap). Captured by the measurement wrapper, not by a human stopwatch.
- **Stop, TTFV-1:** a scored job discovered after T0 is simultaneously (a) queryable through the read API and (b) rendered on `/jobs` with a fit-score badge (the badge whose numeric-color contract is already guarded — `docs/local-reliability-qa.md:140`). The probe asserts all-state pre-work baseline absence, `discoveredAt >= T0`, hashed real discovery-source provenance, and matching UI evidence; UI-only or API-only is insufficient.
- **Stop, TTFV-2:** a tailored resume PDF for the same measured job is viewable in Apply Review (`/apply-review`), meaning the resume surface renders and its final-file PDF link resolves to a real artifact byte stream.

Each stop condition must be encoded as an automated probe (a read-model query plus a rendered-surface assertion) so the measurement is reproducible and the "value" is proven, not asserted.

### 1.3 Clean-environment measurement protocol

The number is meaningless without a defined environment. The protocol must specify, and the harness must enforce or record:

- **Environment.** A fresh VM image or ephemeral container with none of the JobCtrl toolchain pre-installed and no repository checkout present. Record OS, architecture, CPU class, RAM, and a coarse network-bandwidth class in the measurement record.
- **Cold caches (enumerated, must all be empty at T0).** The pnpm store; the uv/pip cache; the Playwright browser cache (`~/Library/Caches/ms-playwright` on macOS, the platform equivalent elsewhere — the shared-cache GC hazard is already documented at `README.md:90-97`); any existing Python virtualenv under `workers/automation`; any `node_modules`; the vendor SDK wheels; and the local workspace `~/.jobctrl` (or the `JOBCTRL_DIR` in use). A warm cache invalidates the run.
- **Allowed vs disallowed network.** Package/tool/browser downloads are allowed because they are part of the setup cost. Real job-source crawling and real LLM provider calls are allowed only for the owner-run measurement and must be bounded to the one configured discovery target and the one measured job. Auto-apply, browser submission, mailbox scans, seeded data, fixtures, and CI are disallowed.
- **Auth precondition, stated per scenario.** Because setup can reuse existing vendor auth, "clean" must declare whether vendor credential stores are present or absent. The owner records **cold-auth** or **warm-auth** notes outside committed artifacts; the measurement record itself must not contain credentials or provider logs.
- **Timestamping and phase breakdown.** The wrapper records T0, the stop timestamps, and a per-phase breakdown so a regression localizes to a phase rather than to an opaque total. Minimum phases: toolchain install; workspace init (`jobctrl init`); stack start (`pnpm dev` to worker-healthy per `GET /v1/health` — `docs/local-reliability-qa.md:45-50`); real discovery/scoring/tailoring (`jobctrl run discover score tailor --limit 1 --workers 1`); navigation-to-value (per stop probe).
- **Statistics and reference class.** The gate is the owner's Apple-silicon macOS reference machine, median of three clean runs under threshold with the worst run under 1.5× threshold, pre-release cadence only.
- **Platform coverage, honestly recorded.** The owner macOS run is the gate. Other platform runs are optional sanity data for Goal C and must be labeled as non-gating if recorded.

### 1.4 The measurement record (source of truth for Goals A and C)

The harness emits one machine-readable record per run (JSON), containing:
environment metadata, per-phase durations, the two totals, pass/fail against
each threshold, and the harness/commit identity. These records are the **source
of truth** for the TTFV metrics and the primary evidence feeding the packaging
decision (§3). The record stores hashes, counts, coarse environment facts,
timestamps, status codes, content type, and byte length; it never contains real
profile, resume, credential, provider-log, local-path, job-title, or job-URL
data.

### 1.5 Entry into the reliability QA matrix

Add first-run TTFV to `docs/local-reliability-qa.md` as recurring regression checks with explicit thresholds:

- A new risk row (or a short dedicated subsection) pairing the risk — *"First-run time-to-value is claimed from incomplete evidence or regresses beyond budget"* — with the owner-run real-path harness and the explicit thresholds.
- **Cadence, split by cost.** Probe logic and summary-gate tests run routinely without spend. Full clean-environment real-path runs are owner-run only, pre-release only, and never CI.
- **Phase-level budgets.** Beyond the two top-line thresholds, record per-phase durations so a regression report says *which* phase consumed the time. Initial budgets come from the first honest owner baseline.
- **No unattended spendful work.** The real gate spends only when the owner runs it intentionally; no CI or agent should run it unattended.

### 1.6 Goal A acceptance gates

- [ ] TTFV-1 and TTFV-2 are defined with machine-checkable start/stop probes (read-model query + rendered-surface assertion), not human timing.
- [ ] The clean-environment protocol enumerates cold caches, network policy, and both auth scenarios; the harness enforces/records them.
- [ ] The real-path wrapper produces a documented, reproducible measurement record with all-state baseline hashes, post-T0 discovered-job proof, same-job API/UI/PDF evidence, and a per-phase breakdown.
- [ ] `docs/local-reliability-qa.md` carries the TTFV regression entry with explicit thresholds and the owner-run pre-release cadence.
- [ ] Optional platform evidence is recorded honestly as non-gating unless the owner changes the reference class.

---

## 2. Goal B — Synthetic sample data as the first-run experience — **WITHDRAWN 2026-07-06 (owner amendment above; PR #330 closed unmerged)**

**Objective.** On a fresh workspace, JobCtrl demonstrates end-to-end value — a scored job and a reviewable tailored resume PDF — using safe synthetic data, *before* the user imports a real profile or configures any auth, with an absolute guarantee that sample data never mixes into real records or reaches a real employer.

### 2.1 What synthetic assets exist today (grounded inventory)

All current synthetic fixtures live on the **test/tooling surface**, not the product surface:

- **`apps/api/test/qa-seed.ts`** — the canonical synthetic seed. It builds a full `QaWorkspace` (`createQaWorkspace`, `seedQaWorkspace`, `seedQaDatabase`) containing: a synthetic profile "QA Candidate" (`qa@example.local`); four jobs including a fully-prepared greenhouse "Director of Platform Engineering" (`https://boards.greenhouse.io/gitlab/jobs/qa-platform-director`, fit score 9) with tailored resume `.txt`/`.pdf`/`.html`, cover letter, employer analysis, requirement-fit report, bullet provenance, and layout boxes; jobs in mixed states (unscored, score-failed, tailor-blocked); a current worker heartbeat; and an apply run. It writes projection-shaped tables directly, so the read model renders it. Its CLI entry (`apps/api/test/qa-seed.ts:1167-1180`) prints a JSON workspace report.
- **`pnpm qa:seed`** → `apps/api/package.json` `qa:seed` (`tsx test/qa-seed.ts`), surfaced at `package.json:36`. Documented for disposable-workspace testing in `docs/user/getting-started.md:149-166` and `docs/user/data-and-safety.md:123`.
- **`apps/web/e2e/fixtures/global-setup.ts`** — invokes `qa-seed.ts` to build the E2E database; **`apps/web/e2e/fixtures/seed.sql`** is a documentation placeholder pointing back to it.
- **`apps/web/e2e/tests/docs-screenshots.spec.ts`** + **`pnpm docs:screenshots`** (`package.json:38`) — renders eight synthetic screens (`dashboard`, `jobs`, `apply-review`, `profile`, `discovery`, `pipelines`, `runs`, `job-detail`) into `docs/assets/screenshots/*.png` (all eight committed). Process documented at `docs/local-development.md:211-247`.
- **`apps/api/test/qa-workflow.test.ts`** — destructive-UI QA against a `qa:seed` workspace (the matrix row at `docs/local-reliability-qa.md:124`).

**Critical caveat the implementer must confront:** `qa-seed.ts` is a *test* fixture, not a polished demo. It deliberately embeds redaction tripwires — `"RAW PROMPT SECRET"`, `"FULL PROFILE SECRET"`, `"/private/secret-resume.pdf"` (`apps/api/test/qa-seed.ts:733-739`) — that API redaction tests assert are stripped from responses. A product-facing sample experience must not surface those sentinels. This forces an explicit data-source decision (§2.3).

Today's "never mixes" guarantee is **workspace-level separation only**: the seed targets a disposable `JOBCTRL_DIR`, never `~/.jobctrl` (`docs/user/getting-started.md:163-166`, `docs/user/data-and-safety.md:123`). That is safe but it is not an in-product first-run experience — it requires the user to run a test tool and point the app at a throwaway directory.

### 2.2 Product invariants

1. **Value before commitment.** A fresh workspace (empty DB, no profile — the `jobctrl doctor` "candidate profile MISSING → run 'jobctrl init'" state at `workers/automation/src/jobctrl/cli.py:1804-1809`) can present a scored job and a reviewable tailored resume PDF via a labeled sample dataset, before real profile import or auth.
2. **Representative rendering.** Sample data flows through the *same* projections and read model as real data, so what the user sees is faithful — no bespoke mock surface.
3. **Unmistakable labeling.** Every sample record is visibly marked as sample/demo wherever it renders (list, detail, dashboard, Apply Review). A user can never confuse a sample job for a real one.
4. **Explicit, reversible, user-approved.** Loading sample data is an opt-in action; clearing it is a single confirmed action that removes all sample records and leaves real records untouched.
5. **Safety over demo (the load-bearing invariant).** Sample data must never mix into real records and must never reach a real employer. This invariant outranks every other consideration in this goal.

### 2.3 Data-source decision (open owner decision D1)

Two viable sources; the plan requires the owner to choose because they trade UX richness against fixture hygiene:

- **Option A — curate a product-owned sample dataset** derived from the `qa-seed.ts` shape but stripped of test sentinels and promoted out of `apps/api/test/` into a product-owned fixture location. Richest demo (mixed job states, full audit trail), but requires disciplined separation from the test fixture so redaction tripwires never leak.
- **Option B — author a separate, minimal curated demo fixture** and keep `qa-seed.ts` strictly test-only. Cleaner separation, less coverage of edge states, some duplication of shape.

Either way, the sample dataset becomes the **synthetic regression fixture** referenced by the acceptance template (§2.7) and the vehicle that satisfies the TTFV stop conditions (§1).

### 2.4 Where sample data surfaces on first run

- The empty-state surfaces (Dashboard and Jobs) gain a first-run affordance offering to load the labeled sample dataset. The plan requires an explicit empty-state call-to-action plus a command-line path; it does not prescribe exact visual design.
- After load, the scored sample job renders on `/jobs` and its tailored resume PDF is reviewable on `/apply-review`, satisfying TTFV-1 and TTFV-2 with zero spend.
- The sample dataset is offered only when the workspace is genuinely fresh; it is never auto-injected into a workspace that already holds real records.

### 2.5 Opt-out and clean replacement

- **Clear.** One confirmed "clear sample data" action removes every sample record atomically and returns the workspace to the true empty state — no residue in events, projections, artifacts, or read model.
- **Replace with real data.** Beginning real work (profile import, real Discover) must never merge into or inherit from sample records. Either require clearing sample data before real work begins, or keep sample data strictly partitioned and excluded from every real operation. The choice interacts with the never-mix mechanism (§2.6) and is folded into open decision D2.
- **Re-tailor / regeneration discipline.** Consistent with the repo's re-tailor rules, loading or clearing sample data must never destroy a real user's last accepted artifact; the two datasets are independent.

### 2.6 The never-mix guarantee (safety design; open owner decision D2)

Two mechanisms, presented for an explicit owner choice because this is a safety property, not a UX preference:

- **Option 1 — separate demo workspace (partition by `JOBCTRL_DIR`).** The first-run experience provisions or points at a disposable demo workspace distinct from `~/.jobctrl`, extending today's proven separation (`docs/user/getting-started.md:163-166`). Strongest isolation (sample data physically never touches the real DB); weaker UX (the demo lives in a separate workspace the user visits).
- **Option 2 — in-workspace partition by explicit provenance marker.** Sample records live in the real workspace but carry a persisted sample/demo marker (a flag or reserved namespace/source) that travels source → events → projections → read model. Richer UX (demo appears in the real app); higher risk, so it must satisfy every clause below:
  - **Live apply is hard-blocked for sample jobs** — the highest-severity clause; no real employer can ever receive a sample application. This composes with the existing default apply-approval gate (`README.md:33-38`), it does not replace it.
  - Discovery dedup, scoring-policy learning, spend accounting, and outcome funnels all **exclude** sample records.
  - `jobctrl backup` / export and any bug-report capture either exclude sample data or mark it unambiguously.
  - A real record can never acquire the sample marker, and a sample record can never lose it.

Whichever option is chosen, the guarantee must be proven by regression fixtures (§2.7), not asserted.

### 2.7 Acceptance-template answers (repo root-cause discipline)

| Template field | Answer for the sample-data experience |
|---|---|
| **Source of truth** | The curated synthetic sample dataset (the §2.3 fixture). Real data's source of truth remains SQLite `~/.jobctrl/jobctrl.db` (`README.md:122-124`). |
| **Owning bounded context** | `operations` for the onboarding/read-side load-and-clear seam; `profile` for the sample candidate profile. Sample provenance, if in-workspace (D2 Option 2), is a cross-context marker owned at the persistence/event layer. |
| **Projection / read model** | The same `job_list_projections` / `job_detail_projections` / `dashboard_projections` and audit projections real data uses — sample rows must render through them unchanged, with the sample marker carried if D2 Option 2 is chosen. |
| **UI surface** | Dashboard and Jobs empty-state load affordance; `/jobs` (scored sample job); `/apply-review` (reviewable tailored resume PDF); sample labeling everywhere a sample record renders. |
| **Approving user action** | Explicit opt-in "load sample data"; explicit confirmed "clear sample data." No silent injection. |
| **Synthetic regression fixture** | The curated sample dataset plus tests proving: renders through the real read model; never-mix (real ⇎ sample marker integrity); clean removal with zero residue; live apply refused for sample jobs. |
| **Local QA path** | `pnpm qa:seed` for the disposable workspace baseline, plus a new load/clear product-path test and a first-run QA smoke; run through the API + web suites (§4). |

### 2.8 Goal B acceptance gates

- [ ] Data-source decision (D1) recorded; if Option A, redaction sentinels never surface in any product response or UI.
- [ ] Fresh-workspace first-run offers labeled sample data via an empty-state affordance and a command path; never auto-injected into a non-empty workspace.
- [ ] Sample data renders through the real read model and is unmistakably labeled on every surface.
- [ ] Never-mix mechanism (D2) chosen and implemented; regression fixtures prove marker integrity, live-apply refusal for sample jobs, and residue-free clearing.
- [ ] The sample dataset satisfies both TTFV stop conditions with zero LLM spend and no crawl.

---

## 3. Goal C — Packaging decision framework

**Objective.** Decide *whether* to build a packaged desktop install using measured evidence, **after** the low-friction install plan (PR #254) lands — never as an upfront commitment. Produce a decision artifact, not a package.

### 3.1 Framing and gate

A packaged desktop install is a roadmap candidate (`README.md:53` points hosted/packaged futures to `ROADMAP.md`; `docs/user/getting-started.md:9` confirms none exists). The decision must not be taken before both preconditions hold:

- **Gate C-precondition-1:** PR #254 has landed (its `jobctrl setup`, `doctor` ensemble checks, and S5 Linux wheel-gap remediation are the baseline the packaging question is asked *against*).
- **Gate C-precondition-2:** at least one full clean-environment TTFV measurement cycle (§1) has been recorded across the supported platforms.

### 3.2 Decision inputs (criteria and measurements)

The decision weighs measured evidence, not intuition:

- **TTFV results (§1).** If the source install reliably meets TTFV-1 ≤ 10 min and TTFV-2 ≤ 30 min across supported platforms and both auth scenarios, the marginal value of packaging is low. If it does not, packaging becomes a candidate remedy — but only for the specific phases it can shorten.
- **Observed setup drop-off / friction map.** From the clean-environment per-phase breakdown, identify which phases most often fail or exceed budget, and on which platforms. Packaging is justified only where it removes a dominant, install-time drop-off that neither the source path nor PR #254's `setup` command can.
- **Platform coverage, including the Linux wheel gap.** PR #254 documents that the pinned Codex runtime wheel has no glibc/manylinux coverage (only macOS, Windows, musllinux). If glibc-Linux remains unsupported after PR #254's S5 remediation, that gap is a first-class input: does a package meaningfully widen platform reach, or would it inherit the same wheel constraints?
- **Maintenance and cost.** Packaging adds build, code-signing, notarization, auto-update, and signing-key custody burdens, weighed against the friction it removes.

### 3.3 Hard constraint inherited from PR #254

**A package cannot solve the vendor-binary distribution problem.** PR #254 establishes that no JobCtrl artifact may redistribute vendor binaries (the Claude Code CLI is proprietary/no-redistribution; Codex/Antigravity binaries arrive only as pinned PyPI wheels). Any packaged desktop app must therefore still orchestrate the *same* PyPI-delivered dependency install at first launch rather than embedding those runtimes. This materially weakens the packaging case — a package wraps the existing install, it does not replace it — and the decision artifact must state this explicitly so the option is not overvalued.

### 3.4 Decision artifact

- The decision is recorded as an ADR appended to `docs/decisions.md` (the repo's decision-record home), containing: the measured TTFV table; the friction map; the platform-coverage matrix with the glibc-Linux disposition; the §3.3 constraint; and a **go / defer / no-go** verdict with rationale.
- **Go** promotes the work to a future dated plan under `docs/plans/` (this plan does not design the package). **Defer / no-go** records the evidence and an explicit re-evaluation trigger (for example: "revisit when upstream glibc wheels land, or when clean-env TTFV-1 median exceeds budget on a supported platform").

### 3.5 Goal C acceptance gates

- [ ] Both C-preconditions hold before any verdict is written.
- [ ] The ADR presents measured TTFV data, the friction map, and the honest platform matrix — no unmeasured claims.
- [ ] The §3.3 no-redistribution constraint is stated and its effect on the packaging case is reflected in the verdict.
- [ ] The verdict is go/defer/no-go with a recorded re-evaluation trigger; "go" spawns a separate plan rather than expanding this one.

---

## 4. Verification (commands to run when this plan is implemented)

This is a docs-only PR; the plan changes no code. The commands below are the acceptance surface for the *implementation* work this plan describes, drawn from the CLAUDE.md matrix and `docs/local-reliability-qa.md:18-36`.

For the real-path TTFV wrapper, summary gate, and docs:

```bash
node --test scripts/ttfv-real.test.mjs
pnpm docs:build
pnpm check
```

For the Python worker and product surfaces that the real path depends on:

```bash
pnpm test
pnpm --filter @jobctrl/web test
uv --project workers/automation run --extra dev pytest -q
uv --project workers/automation run --extra dev ruff check .
```

For the full clean-environment run, the owner runs the protocol in
`docs/developer/first-run-ttfv.md`. It emits the §1.4 measurement record and is
never automated, never CI, and never run without the owner present.

Full suite and hygiene:

```bash
git diff --check
```

For this documentation PR specifically: confirm the plan renders and its references resolve (paths are given in backticks precisely so they are not treated as site links; PR #254 is referenced by number, not as an in-repo link).

**Prohibited during automated verification:** auto-apply, browser submission,
mailbox scans, synthetic/sample TTFV records, seeded jobs, and real LLM or crawl
spend. Real crawling and LLM calls occur only in the owner-run clean baseline.

---

## 5. Definition of Done (for the implementation this plan authorizes)

1. TTFV-1 and TTFV-2 are defined with automated start/stop probes; the clean-environment protocol (caches, network, auth scenarios, statistics, reference class) is documented and enforced by the harness.
2. The real-path TTFV check is a recurring owner-run entry in `docs/local-reliability-qa.md` with explicit thresholds and pre-release cadence; no synthetic/sample/fake record is accepted.
3. The wrapper records all-state baseline hashes, post-T0 discovered-job proof, hashed real discovery-source provenance, same-job TTFV-1/TTFV-2 binding, and PDF byte-stream proof without storing sensitive job/profile/artifact contents.
4. The packaging decision framework is documented; when both C-preconditions hold, an ADR records the go/defer/no-go verdict with measured evidence and a re-evaluation trigger.
5. All touched-surface commands in §4 pass; the review gate returns `Gate: PASS` and the QA gate returns `Gate: PASS`; no Blocker/High findings remain.

---

## 6. Non-goals

- **Not re-specifying PR #254.** Install mechanics, ensemble auth detection/enrollment, `doctor`/`setup` ensemble checks, and the Linux wheel-gap remediation belong to PR #254; this plan consumes them.
- **Not building a package.** Goal C decides *whether*; it does not design or ship one.
- **Not changing ensemble/pipeline semantics.** No changes to scoring, tailoring, retry, spend, or apply behavior; this is a measurement layer.
- **Not shipping real data anywhere.** Measurement records store timings, hashes, counts, coarse environment data, and byte-stream proof only; no real profile, resume, credential, provider-log, local-path, job-title, or job-URL data is committed.
- **No marketing framing or comparisons to other products.** Neutral product language only.

## 7. Risks and mitigations

- **Synthetic or seeded evidence accidentally accepted as TTFV.** Mitigation: the wrapper rejects synthetic/sample/fake paths, records all-state pre-work baseline hashes, requires post-T0 `discoveredAt`, and rejects missing real discovery-source proof in the summary gate.
- **Real-path TTFV spends unexpectedly.** Mitigation: the full clean run is owner-run only, pre-release only, never CI, and documented as spendful; automated checks exercise only no-spend parser/probe/gate logic.
- **Test-fixture sentinels leaking into a demo.** Mitigation: D1 forces an explicit source decision; if the test fixture is reused, sentinels must be stripped and that stripping is tested.
- **Clean-VM measurement is heavy/flaky.** Mitigation: split cadence (cheap sub-phases routine; full clean-VM scheduled), statistic-based thresholds, and a defined reference-machine class.
- **Platform gap distorts the picture.** Mitigation: record glibc-Linux honestly as non-passing until PR #254 S5 lands; treat it as a Goal C input, not a hidden failure.
- **Packaging overvalued.** Mitigation: the §3.3 no-redistribution constraint is stated up front so the option is judged on what a package can actually remove.

## 8. Open owner decisions

All four were resolved by the owner on 2026-07-06:

1. **D1 — sample data source:** curate a product-owned dataset from the `qa-seed.ts` shape (Option A) or author a separate minimal demo fixture and keep `qa-seed.ts` test-only (Option B)?
   - **Resolved (2026-07-06): moot — Goal B withdrawn** (owner amendment at
     the top of this plan). No sample dataset ships in any form.
2. **D2 — never-mix mechanism:** separate disposable demo workspace (Option 1, strongest isolation) or in-workspace partition by an explicit sample provenance marker (Option 2, richer UX, must satisfy every safety clause in §2.6)?
   - **Resolved (2026-07-06): moot — Goal B withdrawn.**
3. **TTFV reference class and statistic:** which machine class and which pass statistic (median + worst-case ceiling vs. strict max) define the gate, and what are the initial phase budgets from the first clean baseline?
   - **Resolved (2026-07-06):** reference class = the owner's Apple-silicon
     macOS machine; statistic = median of 3 clean runs under threshold, worst
     run under 1.5× threshold. Initial phase budgets set from the first
     real-path baseline run. Measurement is real-path only (owner amendment).
4. **Cadence of the full clean-VM run:** pre-release only, fixed schedule, or both — and on which platform set beyond macOS (given the glibc-Linux gap)?
   - **Resolved (2026-07-06):** pre-release only, macOS. A Linux run remains a
     discretionary owner sanity check, not a gate.

---

## Appendix — anchors verified against main @ a488e4e9

- Synthetic seed: `apps/api/test/qa-seed.ts` (`createQaWorkspace`/`seedQaWorkspace`/`seedQaDatabase`; jobs incl. `https://boards.greenhouse.io/gitlab/jobs/qa-platform-director`; approved `resume_pdf`; redaction sentinels at `:733-739`; CLI entry `:1167-1180`).
- Seed wiring: `apps/api/package.json` (`qa:seed`, `qa:test`); `package.json:36,38,12,13,14,47,46`; `apps/web/e2e/fixtures/global-setup.ts`; `apps/web/e2e/fixtures/seed.sql`; `apps/web/e2e/tests/docs-screenshots.spec.ts`; `apps/web/e2e/playwright.config.ts:56-60`; `apps/api/test/qa-workflow.test.ts`.
- Committed synthetic screenshots: `docs/assets/screenshots/{dashboard,jobs,apply-review,profile,discovery,pipelines,runs,job-detail}.png`.
- Onboarding + safety docs: `docs/user/getting-started.md:9,27-31,86-96,149-166`; `docs/user/normal-flows.md`; `docs/user/data-and-safety.md:114-123`; `docs/local-development.md:211-247`; `README.md:33-38,53,90-97,122-124`.
- QA matrix: `docs/local-reliability-qa.md:18-36,45-50,69,124,140,165`.
- CLI/config: `workers/automation/src/jobctrl/cli.py:651` (`init`), `:1781` (`doctor`), `:1804-1809` (empty-profile state); `workers/automation/src/jobctrl/config.py:1192` (`TIER_LABELS`), `:1205-1210` (tiers), `:1231` (`check_tier`).
- Scripts + env: `scripts/install`, `scripts/dev`, `.env.example`.
- Decision-record home: `docs/decisions.md`; plan conventions: `docs/plans/README.md`.
- PR #254 (open, not on `main`): low-friction install and auth-reuse plan — `jobctrl setup`, `scripts/install.sh` bootstrap, `doctor` ensemble checks (S1), leg enable/disable (S4), glibc-Linux Codex wheel-gap remediation (S5), and the no-vendor-binary-redistribution stance.

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
