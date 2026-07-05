# OSS Release — Drive-to-Done and Completion Verification Plan

> **Anchors verified against main @ `a488e4e9853dde292badc74a88c7de24160edc52`.**
> **Type:** thin drive-to-done overlay. It does not re-specify anything.
> **Source of truth for every work item:** `docs/plans/2026-07-03-oss-release-remediation-spec.md`
> (the "spec"). This plan tracks that spec to completion against `main`, proves
> each item's Definition of Done actually holds, and assembles the publication
> go/no-go gate. Where this plan and the spec disagree on WHAT an item must do,
> the spec wins; this plan only governs HOW we confirm the spec is done.

---

## 0. Purpose, scope, and non-goals

The spec is a self-contained, prescriptive remediation program (workstreams W0
privacy/hygiene, W1 apply/runtime safety, W2 public surface/governance) whose
implementation is already underway. This plan adds the missing "are we actually
finished, and can we prove it" layer:

1. A **deterministic status-inventory method** so any agent can reproduce, from
   `main` alone, whether each W-item is merged / in-flight / not-started /
   landed-with-residual.
2. A **residual-gap capture** format and home for items that landed but whose
   spec Definition of Done (DoD) does not fully hold on `main`.
3. A **completion-verification** procedure that proves each item's DoD holds on
   `main` — by running the item's own acceptance checks and the spec's command
   matrix, not by trusting that a PR merged.
4. A **publication go/no-go checklist** that ties spec completion to release
   readiness and to every owner checkpoint the spec lists.

### 0.1 Non-goals (explicit)

- **No re-implementation.** This plan writes no product code and changes no
  item's behavior. It only observes, proves, and records.
- **No re-design.** It does not alter any item's objective, ordering, gate, or
  DoD. If an item's DoD looks wrong, that is a spec change (owner call), not a
  drive-to-done action.
- **No re-scoping.** It does not add, split, merge, or drop W-items. New work
  discovered during verification becomes a **residual follow-up** (§3), never a
  silent expansion of an existing item. Per CLAUDE.md, scope growth stops and is
  raised, not absorbed.
- **No owner-only actions.** Repository visibility flip, the first release tag,
  the distribution-name decision, spend-ceiling defaults, and accepted-risk
  sign-offs remain owner-executed (spec §0.5, §5). This plan prepares and
  verifies; it never executes them.

---

## 1. Baseline snapshot (grounded at main @ `a488e4e9`)

This snapshot is the **starting inventory**, produced by the method in §2. The
method — not the snapshot — is the deliverable; re-run §2 to refresh it.

**Already landed on `main`:**

- **W0.1–W0.6 merged** — PRs #242 (untrack planning corpus), #243 (scrub
  fixtures), #244 (disable tag publishing / W0.5), #245 (release_check v2 /
  W0.3), #246 (unfiltered privacy CI gate / W0.4), #247 (sanitized concerns
  follow-ups / W0.6).
- **Temporal program P0–P5 merged** — PRs #233 (P0), #231 (P1a), #235 (P1b),
  #237 (P3), #238 (P2), #239 (P4), #240 (P5). **Consequence:** every W1/W2 gate
  in spec §0.1 is satisfied, so the spec's "entire PR #232 program already
  delivered" branch is in force — W1.1→W1.8 may proceed as one stacked series
  and W2 items are unblocked, subject to the spec's own DoD.

**Not yet landed on `main`:**

- **W1.1–W1.8:** not started (diagnostic anchors in §2.4 all in pre-W1 state).
- **W2.1–W2.6:** not started, with two nuances — W2.2's disclosure docs are
  **partially** present (`docs/user/data-and-safety.md` already discloses live
  submission, CAPTCHA solving, credential handling, and the spend ceiling; the
  `doctor` warnings of W2.2 item 2 are pending), and W2.3's target error code
  already exists for an unrelated reason (§2.3 anchor-collision trap).

**In-flight planning that reshapes the trajectory (do not assume merged):**

- **PR #257** proposes an owner naming decision and defers the PyPI
  distribution rename (spec W2.1) to an owner-executed rename train that runs
  last, before the visibility flip; it tombstones W2.1 and rewrites the §5 and
  §0.5.1 lines. Until #257 merges, treat W2.1 as a live spec item AND flag the
  pending owner decision (§6). If it merges, re-run §2 — the W2.1 rows and the
  §5 name line change accordingly.
- **PR #254** proposes a low-friction install / auth-reuse plan; adjacent to the
  W2.6 onboarding surface. It is a plan, not code; it does not change any W-item
  DoD.

---

## 2. Status-inventory method (Goal 1)

Deterministic, reproducible from `main` alone. Every claim about an item's state
must rest on one of three evidence classes below; "I remember it merged" is not
evidence.

### 2.1 The four states

| State | Meaning |
| --- | --- |
| **merged** | The item's change is present on `main` AND its DoD holds (proven in §4). |
| **landed-with-residual** | The item's PR merged, but at least one DoD clause does not fully hold on `main`. Each gap becomes a §3 follow-up. |
| **in-flight** | An open PR implements the item, or the item's predecessor gate is not yet on `main`. |
| **not-started** | No merged or open PR; diagnostic anchors are all in their pre-item state. |

### 2.2 The three evidence classes

- **Class A — merged-PR evidence.** Grep the first-parent history of `main` for
  the item's Conventional-Commit subject stem (the spec gives each item's PR
  title). Command: `git log --oneline origin/main | grep -Ei '<stem>'`. A hit is
  necessary but **not sufficient** — proceed to Class B/C.
- **Class B — spec code-anchor evidence.** For each item, probe the single most
  diagnostic anchor by **symbol name**, never by line number (spec §0.2: line
  numbers have drifted; P4/P5 reshaped several). Command:
  `git grep -n '<symbol>' -- '<path>'` at HEAD. Presence-or-absence of the
  pre-item vs post-item shape classifies the item. The diagnostic anchors are in
  §2.4.
- **Class C — DoD-probe evidence.** Run the item's own acceptance check from its
  spec DoD (fixtures, tripwire promotion, structural checks) plus the §0.3
  command matrix. This is the only class that distinguishes **merged** from
  **landed-with-residual**; it is developed in §4.

### 2.3 Two mandatory traps to guard against

1. **Anchor collision (a string present for the wrong reason).** Presence of a
   token does not mean the item shipped. Confirmed example on `main`:
   `apps/api/src/server.ts` returns `error: "cross_site_request"` in the
   `onRequest` hook, but that is the **pre-existing Origin/Referer gate** (PR
   #217), not W2.3's `Sec-Fetch-Site` gate. W2.3 is **not-started**: there is no
   `sec-fetch-site` handling and `SECURITY.md` documents neither the header
   boundary nor the `JOBHUNTER_API_ALLOW_REMOTE_BIND` escape hatch. Rule: probe
   the item's *distinctive* symbol (here `sec-fetch-site`), not a shared one.
2. **Anchor drift (an anchor moved or was deleted by a later phase).** The spec's
   line hints predate P4/P5. Confirmed example: W1.8 item 2 targets
   `params.get("dryRun", False)` in the RPC `apply_action` handler, but P5
   rewrote that handler to `return build_apply_workflow_spec(params)`
   (`workers/automation/src/jobhunter/infrastructure/rpc/handlers.py`), so the
   original anchor is gone. Rule: when a symbol is absent, follow the call chain
   (here into `build_apply_workflow_spec`) before concluding "done"; re-locate by
   symbol per spec §0.2.

### 2.4 Diagnostic anchors and current-state snapshot

Each row: the single most diagnostic anchor to probe, its pre-item vs
post-item shape, and the state observed at `a488e4e9`. Re-run the Class B probe
to refresh. Full DoD lives in the spec; this table only classifies.

| Item | Diagnostic anchor (probe by symbol) | Post-completion shape | State @ `a488e4e9` | Evidence |
| --- | --- | --- | --- | --- |
| W0.1 | `git ls-files \| grep -c '^\.planning/'` | prints `0`; `.gitignore` has `.planning/` | merged | A #242, B (=0) |
| W0.2 | owner-PII needles absent from tracked fixtures | synthetic data only | merged | A #243, C via W0.3 |
| W0.3 | `scripts/release_check.py`; `--strict-prompt`; `workers/automation/tests/test_release_check.py` | v2 needles + self-test | merged | A #245, B present |
| W0.4 | `.github/workflows/release-check.yml` | no `paths:` filter | merged | A #246, B present |
| W0.5 | `.github/workflows/publish.yml` trigger | `workflow_dispatch` only | merged | A #244, B present |
| W0.6 | `docs/backlog.md` "Release Hardening Follow-Ups" | sanitized dispositions | merged | A #247, B present |
| W1.1 | `partial_override_run_id` on the decision row | column + claim predicate | not-started | B absent |
| W1.2 | `RESULT:APPLIED`→`DryRunComplete` coercion in `infrastructure/apply/claude_code_cli.py` | replaced by `dry_run_violation` | not-started | B coercion present |
| W1.3 | `--permission-mode bypassPermissions`; `infrastructure/apply_tools/` | allowlist; owned MCP server exists | not-started | B bypass present ×2, dir absent |
| W1.4 | fabricated `Age 18+` / `Felony` block in `apply/prompt.py` | deleted; typed attestations | not-started | B block present |
| W1.5 | profile-password interpolation in `apply/prompt.py` | removed; owned `type_credential` | not-started | B interpolation present |
| W1.6 | `_build_captcha_section` / `CAPSOLVER_API_KEY` in `apply/prompt.py` | owned `solve_captcha` tool | not-started | B present |
| W1.7 | email-only send path / `EmailApplicationCandidateRecorded` | owned send + candidate event | not-started | B absent |
| W1.8 | `def apply(... dry_run=Option(False ...))` in `cli.py`; strict tripwires in CI | dry-run default; `--submit`; strict CI | not-started | B default `False`, warnings-only |
| W2.1 | `[project] name` in `workers/automation/pyproject.toml` | renamed distribution | not-started (owner decision in-flight #257) | B `jobhunter` |
| W2.2 | `Responsible use` in `README.md`; `doctor` capability notices | docs + `doctor` warnings | landed-with-residual (docs largely present; `doctor` warnings pending) | B partial |
| W2.3 | `sec-fetch-site` handling in `apps/api/src/server.ts`; boundary in `SECURITY.md` | header gate + docs | not-started | B absent (collision, §2.3) |
| W2.4 | per-lane attribution on the `llm_spend` write seam | lanes on P5's ledger | not-started (P5 base present) | B base present, delta absent |
| W2.5 | DCO workflow; sign-off section in `CONTRIBUTING.md` | DCO green + doc | not-started | B absent |
| W2.6 | `doctor` Tier-2 per-link auth chain | Claude/Codex/Gemini per-link status | not-started (Tier-2 stub present) | B partial |

### 2.5 Reproducible procedure (run to refresh the inventory)

1. `git fetch origin main` then `git rev-parse origin/main` — record the ref in
   the refreshed table header.
2. For each item: run its Class A grep, its Class B `git grep`, and (for any
   item whose A+B say "present") its Class C DoD probe from §4.
3. Classify into one of the four §2.1 states. For **landed-with-residual**, open
   a §3 follow-up per failing DoD clause.
4. Publish the refreshed table (this section) and the go/no-go checklist (§5) in
   the drive-to-done tracking PR description; never in a committed doc that would
   carry stale state.

---

## 3. Residual-gap capture (Goal 2)

### 3.1 What counts as a residual gap

An item is **landed-with-residual** when its PR merged but a Class C probe shows
a DoD clause not holding on `main` — e.g., a capability shipped but a disclosure
notice, a warning, a fixture, or a parity/exhaustiveness guarantee the DoD
requires is missing. A residual is a real gap in the spec's promised end state,
tracked to closure; it is never a reason to weaken the DoD.

### 3.2 Follow-up record format

Each residual is one record with these fields:

- **ID** — `RES-<item>-<n>` (e.g. `RES-W2.2-1`).
- **Spec item** — the owning W-item and the exact DoD clause not holding.
- **Invariant** — the product invariant the clause protects (root-cause framing
  per CLAUDE.md: name the invariant before the fix).
- **Evidence** — the Class C command and its actual result on `main`.
- **Route** — one of: **fix-forward** (a follow-up PR, referenced by number once
  open) or **backlog** (a sanitized `docs/backlog.md` entry) or **owner-accepted**
  (owner sign-off recorded per spec §0.5.3).
- **Owner** — the accountable party for closing it.

### 3.3 Where follow-ups live

- **Public, sanitized:** `docs/backlog.md` under the existing "Release Hardening
  Follow-Ups" section (added by W0.6, PR #247). Sanitized means: no
  file-located vulnerability descriptions, no exploit detail, no PII — same bar
  as spec W0.6.
- **Sensitive detail (file-located weaknesses, needle values, concern text):**
  the owner's private off-repo artifact only (spec §0.2, §2 W0.6). Never
  committed, never in PR/issue text — those become public on the visibility flip.
- **Live tracking:** the drive-to-done PR description carries the current
  residual list with routes and owners; `docs/backlog.md` holds the durable
  sanitized entries.

### 3.4 Known residuals at snapshot (starting set)

- **`RES-W2.2-1`** — spec W2.2 item 2 (`doctor` prints notices for active
  LinkedIn/Indeed boards, configured CapSolver key, approval gate off,
  incomplete attestations, including the hardcoded board fallbacks re-located
  after P4). Docs (item 1) are largely present in `docs/user/data-and-safety.md`;
  the `doctor` warnings are pending. Route: fix-forward under W2.2. Note the spec
  itself flags this as splittable and P4/P5-gated.
- Any item that lands during the drive with a failing Class C probe is appended
  here by the §2.5 procedure.

W2.3, W2.4, W2.5, W2.6, and all of W1 are **not-started**, not residual — they
are ordinary remaining work under the spec, tracked by the go/no-go checklist
(§5), not by §3.

---

## 4. Completion verification (Goal 3) — prove DoD holds on `main`

**Principle: merged ≠ done.** An item is complete only when its spec DoD clauses
pass on `main` HEAD. Verification re-runs the item's own acceptance checks; it
does not invent new ones. Source of truth for each check is the item's DoD in the
spec; this section maps DoD clauses to exact commands.

### 4.1 Global command matrix (spec §0.3; verified present in `package.json`)

Run the subset for the surfaces an item touched; run the full sweep before
declaring any item done and before the release gate.

| Surface | Command | Required result |
| --- | --- | --- |
| Python worker | `uv --project workers/automation run --extra dev pytest -q` | 100% pass |
| Python lint | `uv --project workers/automation run --extra dev ruff check .` | `All checks passed!` |
| Python package | `uv --project workers/automation run --extra dev python -m build workers/automation` | builds clean |
| TS API | `pnpm api:check` then `pnpm api:test` | zero errors / all pass |
| API QA harness | `pnpm qa:test` | all pass |
| Web | `pnpm web:check`, `pnpm --filter @jobhunter/web test`, `pnpm --filter @jobhunter/web test-d` | zero errors / all pass |
| Full check | `pnpm check` | zero errors |
| Full sweep (pre-gate) | `pnpm test` | all pass |
| Privacy | `python3 scripts/release_check.py` | zero findings |
| Privacy (strict, from W1 complete) | `python3 scripts/release_check.py --strict-prompt` | zero findings |
| Hygiene | `git diff --check` | clean |

### 4.2 Per-workstream verification recipes (objective-level)

These say WHAT to prove and WHICH check proves it; they are not step-by-step
scripts. Each recipe defers to the item's spec DoD for the exhaustive clause list.

- **W0 (all merged — confirm no regression).** `python3 scripts/release_check.py`
  exits 0 with zero findings; the W0.3 self-test runs inside
  `uv --project workers/automation run --extra dev pytest -q`
  (`workers/automation/tests/test_release_check.py`);
  `git ls-files | grep -c '^\.planning/'` is `0`; `.github/workflows/release-check.yml`
  has no `paths:` filter and is green on `main`;
  `.github/workflows/publish.yml` has no push/tag trigger; every W0.6 concern
  carries a disposition (owner's private artifact) with sanitized entries in
  `docs/backlog.md`.
- **W1 (enforced guarantees, not intentions).** The decisive, non-negotiable
  proofs: bare `jobhunter apply` performs a dry run (W1.8 CLI test); the apply
  agent's argv carries no `bypassPermissions` and an explicit `--allowedTools`
  with the budget flag (W1.3 golden + parity tests); `apply/prompt.py` contains
  no fabricated screening block, no interpolated profile password, and no
  CapSolver key or embedded REST/JS (W1.4/W1.5/W1.6) — **proven by promoting the
  release_check tripwires to failures**: `python3 scripts/release_check.py
  --strict-prompt` exits 0, and the privacy CI workflow runs `--strict-prompt`
  (W1.8 item 4); the dry-run guard admits only GET/HEAD to every origin and
  records blocked-channel evidence, and a synthetic `RESULT:APPLIED` under
  dry-run maps to `dry_run_violation`, not success (W1.2 adversarial fixtures);
  every new apply event lands in both registries with a web handler, fixture,
  and badge (parity tests `every-event-has-handler.test.ts`,
  `every-stage-state-has-badge.test.tsx` green). Each W1 item additionally
  requires its full sweep (§4.1), including `pnpm qa:test` for W1.1 and W1.7.
- **W2 (public surface).** W2.1: `workers/automation/pyproject.toml` carries the
  owner-approved distribution name and `publish.yml` re-enables its tag trigger
  gated on the release-check workflow — **or** the in-flight #257 deferral is in
  force and the rename train is the tracked owner action (§5). W2.2: both docs
  updated with no capability left undisclosed, and `doctor` warning unit tests
  green (closes `RES-W2.2-1`). W2.3: the `server.test.ts` CSRF matrix passes
  (cross-site browser → 403; same-origin → 200; headerless curl-style → allowed)
  and `SECURITY.md` documents the loopback + Host + Origin/Referer +
  `Sec-Fetch-Site` boundary and the remote-bind escape hatch. W2.4: every
  recorded usage entry is lane-attributed, the apply lane records from the
  adapter parse, a per-lane token ceiling blocks via P5's single
  `check_spend_budget` preflight, and **no second spend table or preflight
  exists** (grep-provable); owner-confirmed defaults are in place. W2.5: the DCO
  workflow is green on its own signed PR and `CONTRIBUTING.md` has the sign-off
  section. W2.6: `doctor` output tests cover all-present and one-missing auth
  links, and no doc claims single-key sufficiency for Tier 2.

### 4.3 Verification discipline

- Verify on `main` HEAD after each merge, not on the feature branch. A DoD that
  passed on a branch can regress under a sibling merge; the parity/exhaustiveness
  tests exist to catch exactly that (spec §0.2).
- Record, for each item, the exact command and its verbatim result in the
  drive-to-done tracker (spec §0.4 report template). "Green in CI" without the
  command output is not acceptance.
- Never weaken, skip, or delete a parity, exhaustiveness, or type-level test to
  make a check pass (spec §0.2). A failing guard is doing its job.

---

## 5. Publication go/no-go checklist (Goal 4)

Mirrors spec §5. Every box needs the stated verification; every owner checkpoint
(spec §0.5) needs a recorded decision. The flip and first tag are owner-only.
Assemble this, with links, as the final release deliverable.

| # | Gate line (spec §5) | Verification step | Owner checkpoint |
| --- | --- | --- | --- |
| 1 | W0.1–W0.6 merged; `release-check` CI green on `main` since W0.4 | §2 shows W0.1–W0.6 = merged; `release-check` workflow green on every `main` commit since #246 | — |
| 2 | Temporal P1b–P5 merged | §2 confirms #235, #237, #238, #239, #240 on `main` | — |
| 3 | W1.1–W1.8 merged, each `Gate: PASS` review + QA | §2 = merged for all eight; §4.2 W1 proofs pass, incl. `--strict-prompt` green in CI | — |
| 4 | Distribution name chosen and live; `publish.yml` re-enabled and gated | §4.2 W2.1 — **or** #257 deferral in force and rename train tracked as the owner action | **§0.5.1 — distribution-name decision (in-flight in #257)** |
| 5 | W2.2, W2.3, W2.5 merged; W2.4 + W2.6 merged or owner-deferred in writing | §4.2 W2 proofs pass; any deferral recorded by the owner | **§0.5.2 — W2.4 per-lane defaults** |
| 6 | W0.6 dispositions closed (fixed / backlogged-sanitized / owner-accepted) | Owner's private disposition artifact complete; sanitized entries in `docs/backlog.md` | **§0.5.3 — each accepted-risk entry** |
| 7 | Owner records acceptance of retained history + capability posture | Owner statement in the flip PR/issue: historical blobs remain reachable; live-submit / CAPTCHA / email-send / LinkedIn-Indeed are deliberate disclosed choices | **owner statement** |
| 8 | Final manual QA (human) | `jobhunter doctor` clean with expected warnings; seeded `/apply-review` smoke (approval → dry-run evidence → gated submit); one harness dry-run showing blocked-channel evidence; **no real applications** | **owner-run** |
| 9 | Owner flips visibility and tags first release | Owner-only action | **§0.5.4 — flip + first tag** |

**Go decision:** all nine rows verified and every owner checkpoint recorded. Any
open Blocker/High review or QA finding, any un-dispositioned W0.6 concern, or any
un-closed residual whose route is not owner-accepted = **no-go** (CLAUDE.md: work
is not done while Blocker/High findings remain).

---

## 6. Risks and open owner decisions

- **Naming / PyPI deferral pending (PR #257).** Reshapes spec W2.1, §0.5.1, and
  §5 row 4. Until it merges, keep W2.1 in the inventory as a live item and treat
  the name as an unresolved owner decision. On merge, re-run §2; the W2.1 rows
  and §5 row 4 convert to the rename-train owner action. **Owner decision.**
- **Per-lane spend-ceiling defaults (spec §0.5.2 / W2.4).** Values are an owner
  confirmation; the drive cannot mark W2.4 done without them. **Owner decision.**
- **Accepted-risk W0.6 concerns (spec §0.5.3).** Each acceptance is owner-only;
  no agent may self-accept. **Owner decision.**
- **Anchor collision / drift.** Verified real on `main` (§2.3): W2.3's error
  code exists for an unrelated gate; W1.8's `dryRun` anchor was erased by P5.
  Mitigation: the method mandates probing an item's *distinctive* symbol and
  following call chains before concluding "done".
- **Sibling-agent merge contention.** Multiple concurrent agents touch
  overlapping files (spec §0.1 collision map). Mitigation: verify on `main` HEAD
  after each merge, lean on parity tests, retry on git-lock contention.
- **Owner-only completion.** Rows 7–9 of §5 cannot be closed by any agent;
  premature "done" is a false-completion risk. Mitigation: the gate blocks on
  recorded owner statements.
- **Residual under-detection.** A merged item can silently miss a DoD clause
  (the W2.2 `doctor` warnings are the live example). Mitigation: Class C probes,
  not Class A/B alone, decide merged-vs-residual.

---

## 7. Definition of Done (for this drive-to-done process)

- The §2 inventory is reproducible from `main` alone and current as of the
  latest `origin/main` ref, with every item in exactly one of the four states.
- Every not-started/in-flight item has a named owner and a route to completion;
  every landed item's DoD is either proven on `main` (§4) or has a logged §3
  residual with a route.
- Every residual has a `RES-…` record with invariant, evidence, route, and
  owner; sanitized entries exist in `docs/backlog.md`; sensitive detail stays in
  the owner's private artifact.
- The §5 go/no-go checklist is assembled with links, each row carries its
  verification result, and every owner checkpoint (§0.5.1–.4 plus the history /
  capability-posture statements) is recorded.
- No parity, exhaustiveness, or type-level test was weakened to reach any green.

This plan itself is done when the above is achievable by following it; executing
it (and reaching the flip) is the owner-gated §5 outcome.

## 8. Verification of this document

Docs-only change; no runtime surface. Confirm:

- `git diff --check` — clean.
- `python3 scripts/release_check.py` — zero findings (this file names no PII, no
  secrets, and no forbidden literals; the three `apply/prompt.py` tripwires
  remain the expected W1-gated warnings and are unaffected by this doc).
- Every path in this plan is backticked and resolves in-repo at
  `a488e4e9`; every PR reference is a real repository PR number; no external
  product or company is named.

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
- Scope note: the stacked PRs on this branch deliver this plan's own artifacts (status inventory, residual-gap records, go/no-go checklist). W-item implementation itself follows the OSS spec's own train sequencing, not this branch.
