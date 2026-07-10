# OSS Release — Drive-to-Done and Completion Verification Plan

> **Closeout status (2026-07-05 R1):** #274 executed this plan's inventory
> method against current `main` and found **NO-GO**, not release-ready. That
> first inventory is historical; §10 restamps the W1 apply-safety residual after
> the W1 remediation train merged.
>
> **Owner decision (2026-07-06):** the spec's former W1.8 dry-run-by-default
> requirement is withdrawn. Non-dry-run remains the default unless callers pass
> `--dry-run` / `dryRun: true`; W1.8 must not be counted as a release gate.
>
> **Anchors verified against main @ `a488e4e9853dde292badc74a88c7de24160edc52`.**
> **Type:** thin drive-to-done overlay. It does not re-specify anything.
> **Source of truth for every work item:** `docs/plans/implemented/2026-07-03-oss-release-remediation-spec.md`
> (the "spec"). This plan tracks that spec to completion against `main`, proves
> each item's Definition of Done actually holds, and assembles the publication
> go/no-go gate. Where this plan and the spec disagree on WHAT an item must do,
> the spec wins; this plan only governs HOW we confirm the spec is done.
>
> **Status update (2026-07-05, after authoring):** the W1–W2 implementation
> was subsequently delivered directly from the spec and is merging to `main`.
> Any per-item status recorded in this document (e.g. "not-started") is the
> authoring-time baseline at `a488e4e9`, now historical. The close-out run
> MUST regenerate the full inventory against current `main` using §1's
> method — do not trust any status written here.
>
> **Post-train closeout status (2026-07-06 R1):** §9 regenerates the inventory
> against `main` @ `fec1940f1ae5459d9d08455d9605931179200fed`, after `gh`
> verified the R10, R7a, and I0 prerequisite trains merged. Result: **NO-GO**.
> W1 apply hardening is not complete: W1.1 is merged, but W1.2-W1.7 remain
> not-done on the checked tree. W1.8 was later withdrawn by owner decision and
> is not a release gate. W2.1 is open, W2.2 and W2.4 are partial, W0.6 is
> repo-side only until owner disposition closure, and D-6/R11 guarded submission
> must wait.
>
> **Latest refresh (2026-07-06, after W1 remediation):** §10 restamps the W1
> residual against `main` @ `660c4f22e64f0be13d7901584b399ba9fd364451`.
> W1.1-W1.7 are complete and W1.8 is withdrawn. The W1 apply-safety
> precondition is now satisfied, but the overall R1 release gate remains
> **NO-GO** until the non-W1 release/owner checkpoints in §10.4 close.
>
> **W0.6 owner pass (2026-07-07):** owner review closed W0.6 as passed. The
> private disposition table remains off-repo; no private concern text is
> committed here, and no W0.6 accepted-risk entry remains a release blocker.
>
> **Owner release decisions (2026-07-10):** prepare v2.0.0 as the first public
> release and explicitly defer W2.4. The existing global estimated daily USD
> ceiling remains shipped; per-lane attribution and token ceilings remain
> backlog. Hosted Actions are rerun immediately after the owner makes the
> repository public; docs deployment, tagging, and publishing remain blocked
> until those real runs are green.

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
  delivered" branch is in force — W1.1→W1.7 may proceed as one stacked series
  and W2 items are unblocked, subject to the spec's own DoD.

**Not yet landed on `main`:**

- **W1.1–W1.7:** not started (diagnostic anchors in §2.4 all in pre-W1 state).
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
   line hints predate P4/P5. Rule: when a symbol is absent, follow the call
   chain before concluding "done"; re-locate by symbol per spec §0.2.

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
  proofs: the apply agent's argv carries no broad permission bypass and uses an
  explicit `--allowedTools` allowlist (W1.3 golden + parity tests);
  `apply/prompt.py` contains
  no fabricated screening block, no interpolated profile password, and no
  CapSolver key or embedded REST/JS (W1.4/W1.5/W1.6) — proven by the
  release_check tripwires exiting cleanly; the dry-run guard admits only GET/HEAD to every origin and
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
The 2026-07-10 hosted-CI exception changes only ordering: exact-tree local green
precedes the flip, and the exact-SHA hosted result closes immediately afterward;
docs deployment, tagging, and publication remain blocked meanwhile. Assemble
this, with links, as the final release deliverable.

| # | Gate line (spec §5) | Verification step | Owner checkpoint |
| --- | --- | --- | --- |
| 1 | W0.1–W0.6 merged; Release Privacy green on the exact public-release `main` SHA | Complete local matrix before the flip; immediately after it, rerun the exact-SHA hosted workflow. Zero-step billing failures do not count. | **2026-07-10 sequencing exception** |
| 2 | Temporal P1b–P5 merged | §2 confirms #235, #237, #238, #239, #240 on `main` | — |
| 3 | W1.1–W1.7 merged, each `Gate: PASS` review + QA | §2 = merged for all seven; §4.2 W1 proofs pass | — |
| 4 | Distribution renamed to `jobctrl`; v2.0.0 selected; guarded release workflow prepared | Source manifests/archive/tag parity pass; `release-pypi.yml` remains disabled until post-public hosted green. | **Resolved 2026-07-10 — v2.0.0** |
| 5 | W2.2, W2.3, W2.5, and W2.6 merged; W2.4 merged or owner-deferred in writing | W2 proofs pass; W2.4's v2.0.0 deferral and retained global USD ceiling are recorded in the spec and backlog. | **Resolved 2026-07-10 — W2.4 deferred** |
| 6 | W0.6 dispositions closed (fixed / backlogged-sanitized / owner-accepted) | Owner's private disposition artifact complete; sanitized entries in `docs/backlog.md` | **§0.5.3 — each accepted-risk entry** |
| 7 | Owner records acceptance of retained history + capability posture | Owner statement in the flip PR/issue: historical blobs remain reachable; live-submit / CAPTCHA / email-send / LinkedIn-Indeed are deliberate disclosed choices | **owner statement** |
| 8 | Final manual QA (human) | `jobctrl doctor` clean with expected warnings; seeded `/apply-review` smoke (approval → dry-run evidence → gated submit); one harness dry-run showing blocked-channel evidence; **no real applications** | **owner-run** |
| 9 | Owner flips visibility; hosted gates execute; owner later tags v2.0.0 | Flip is the controlled unblock; rerun all five exact-SHA hosted workflows immediately. Tag only after hosted green. | **§0.5.4 — flip, verify, then first tag** |

**Go decision:** all pre-flip portions of the nine rows are verified and every
owner checkpoint is recorded; after the controlled flip, row 1's hosted result
must close before docs deployment or the tag. Any
open Blocker/High review or QA finding, any un-dispositioned W0.6 concern, or any
un-closed residual whose route is not owner-accepted = **no-go** (CLAUDE.md: work
is not done while Blocker/High findings remain).

---

## 6. Risks and owner-decision status

The former naming, W2.4, and W0.6 decisions are resolved: the product and
distribution are JobCtrl/`jobctrl`, v2.0.0 is the first public version, W2.4 is
explicitly deferred with its global USD ceiling retained, and W0.6 closed with
no accepted-risk release blocker. Current risks are:

- **Hosted-CI ordering.** Private-repository runs are blocked before execution.
  Mitigation: complete the exact-tree local gate, use the owner-approved public
  flip solely to unblock Actions, rerun all five hosted workflows on that exact
  SHA immediately, and keep docs/tag/publication blocked until green.
- **Anchor collision / drift.** Verified real on `main` (§2.3): W2.3's error
  code exists for an unrelated gate.
  Mitigation: the method mandates probing an item's *distinctive* symbol and
  following call chains before concluding "done".
- **Sibling-agent merge contention.** Multiple concurrent agents touch
  overlapping files (spec §0.1 collision map). Mitigation: verify on `main` HEAD
  after each merge, lean on parity tests, retry on git-lock contention.
- **Owner-only completion.** Rows 7–9 are owner-only, with rows 7–8 required
  before the flip; row 1's hosted result and row 9's hosted-verification/tag
  portion close only at or after cutover. Premature "done" is a
  false-completion risk. Mitigation: the gate blocks on recorded owner
  statements and hosted readback.
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
- Every path in the historical sections resolves in-repo at `a488e4e9`; every
  §9 anchor resolves against `main` @ `fec1940f1ae5459d9d08455d9605931179200fed`;
  every PR reference is a real repository PR number; no forbidden source
  document, secret, or user data is cited.

## 9. Post-train R1 close-out inventory (2026-07-06)

### 9.1 Snapshot and prerequisite gate

- **Tree checked:** `main` @ `fec1940f1ae5459d9d08455d9605931179200fed`.
- **Current-status caveat:** this is a historical snapshot at the checked tree.
  Later `main` changes, including #328, must be evaluated in a refreshed
  residual inventory before using this section as current release evidence.
- **Prerequisite gate:** passed by `gh` at 2026-07-06T11:02:29Z. R10
  politeness train (#272, #297-#316, including #313), R7a launch-asset train
  (#262, #298-#305), and I0 pair (#254 + #317) were all merged.
- **Read constraints honored:** no forbidden competitive/launch strategy
  documents were read or cited; `docs/claims-ledger.md` was read-only.
- **Decision:** **R1 release gate NO-GO**. The merged prerequisite trains do not
  make W1 apply hardening complete.

### 9.2 W1 apply hardening status (R11/D-6 hard precondition)

**Status: NOT COMPLETE.** W1.1 is done. W1.2-W1.7 are not done on the checked
tree, and W1.8 is not counted because the owner withdrew the dry-run-by-default
requirement. R11 guarded submission / browser-extension Phase 3 must not start.

| Item | Status | Evidence on `main` |
| --- | --- | --- |
| W1.1 approval bindings + partial-evidence gate | done | Approval decisions persist `materials_generation`, `profile_version`, `application_url`, and `partial_override_run_id` (`apps/api/src/application-feedback.ts:140`, `:148`, `:469`); stale profile/URL and invalid partial overrides reject at `apps/api/src/application-feedback.ts:965` and `:977`. Passing regressions: `workers/automation/tests/test_apply_regressions.py:539` and `:588`. |
| W1.2 dry-run violation must fail closed | not-done | Current parser still maps `RESULT:APPLIED` during `dry_run` to `DryRunComplete` (`workers/automation/src/jobhunter/infrastructure/apply/claude_code_cli.py:369`-`:376`) and treats `RESULT:DRY_RUN` as success (`:381`-`:382`). Existing CDP guard coverage is useful (`workers/automation/tests/test_apply_chrome_dry_run_guard.py:55`) but does not satisfy W1.2's stricter fail-closed parser/invariant. |
| W1.3 reduce Claude permissions / owned MCP tools / env allowlist | not-done | The adapter still starts Claude with `--permission-mode bypassPermissions` and no owned apply-tool allowlist (`workers/automation/src/jobhunter/infrastructure/apply/claude_code_cli.py:149`-`:156`), and still copies the whole environment (`:159`). |
| W1.4 remove hardcoded legal attestations | not-done | The apply prompt still hardcodes `Age 18+: Yes` and `Felony: No` (`workers/automation/src/jobhunter/apply/prompt.py:78`-`:84`); user docs still tell the operator to confirm those prompt-supplied defaults (`docs/user/security.md:247`-`:249`). |
| W1.5 keep profile password out of prompt | not-done | The prompt still interpolates `personal['email'] / personal.get('password', '')` (`workers/automation/src/jobhunter/apply/prompt.py:614`), and security docs still disclose that profile passwords enter the apply-agent prompt (`docs/user/security.md:209`-`:213`). |
| W1.6 keep CapSolver key out of prompt | not-done | The prompt builder still reads `CAPSOLVER_API_KEY` and inserts `API key: {capsolver_key...}` into prompt text (`workers/automation/src/jobhunter/apply/prompt.py:217`-`:240`). The release-check self-test still expects that tripwire (`workers/automation/tests/test_release_check.py:78`). |
| W1.7 quarantine email application sending | not-done | The apply prompt still instructs the agent to `send_email` and emit `RESULT:APPLIED` for email-only applications (`workers/automation/src/jobhunter/apply/prompt.py:607`-`:609`), while the shipped Gmail connector is documented as read-only (`README.md:58`-`:60`). No `EmailApplicationCandidateRecorded` event exists in the merged tree. |
| W1.8 dry-run-by-default surface defaults | withdrawn | Owner decision #328 removed W1.8 from the release plan. Live/non-dry-run remains the default unless callers pass `--dry-run` / `dryRun: true`; W1.8 is no longer a release requirement, gate, or acceptance criterion. |

### 9.3 W0/W1/W2 inventory

| Item | Status | Evidence on `main` |
| --- | --- | --- |
| W0.1 remove private planning corpus from tracking | done | `.planning/` is ignored at `.gitignore:26`, and `git ls-files` returns no tracked `.planning/` entries. Historical merge anchor: #242 / `9bc9edc`. |
| W0.2 purge owner-derived fixtures and generated artifacts | done | Historical merge anchor: #243 / `a33f1169`; release-check coverage for forbidden/private/runtime/browser-profile classes is at `workers/automation/tests/test_release_check.py:30`-`:80`. |
| W0.3 add/strengthen release scanner | done | Scanner covers text suffixes (`scripts/release_check.py:25`-`:36`), secret assignments (`:89`-`:96`), strict prompt mode (`:208`-`:215`), and W1 prompt tripwires (`:404`-`:419`). Passing self-tests: synthetic violations (`workers/automation/tests/test_release_check.py:30`-`:80`), clean tree (`:83`-`:110`), and prompt-tripwire strict mode (`:142`-`:158`). Historical merge anchor: #245 / `10125d0`. |
| W0.4 wire scanner into CI | done | Release Privacy Gate runs on `push` to `main` and all pull requests (`.github/workflows/release-check.yml:3`-`:7`), then runs the scanner and self-test (`:25`-`:29`). Historical merge anchor: #246 / `066e380`. |
| W0.5 disable publishing while unsafe | done | Publish workflow is manual only, with tag publishing deferred until W2.1 (`.github/workflows/publish.yml:1`-`:5`). Historical merge anchor: #244 / `802f839`. |
| W0.6 close disposition backlog | done | Owner review closed W0.6 as passed on 2026-07-07. Public sanitized follow-ups exist in `docs/backlog.md:34`-`:52`; the private disposition table remains off-repo, and no W0.6 accepted-risk entry remains a release blocker. Historical merge anchor: #247 / `dca6a76`. |
| W1.1 approval bindings + partial-evidence gate | done | See §9.2 W1.1. |
| W1.2 dry-run violation fail-closed | not-done | See §9.2 W1.2. |
| W1.3 reduce Claude permissions / owned MCP tools / env allowlist | not-done | See §9.2 W1.3. |
| W1.4 remove hardcoded attestations | not-done | See §9.2 W1.4. |
| W1.5 remove profile password from prompt | not-done | See §9.2 W1.5. |
| W1.6 remove CapSolver key from prompt | not-done | See §9.2 W1.6. |
| W1.7 quarantine email application sending | not-done | See §9.2 W1.7. |
| W1.8 dry-run-by-default surface defaults | withdrawn | See §9.2 W1.8. |
| W2.1 final distribution name + publish re-enable | not-done | PR #257 is open (`gh pr view 257`: state `OPEN`, no merge commit). The package name remains `jobhunter` (`workers/automation/pyproject.toml:1`-`:3`), and `publish.yml` remains `workflow_dispatch` only (`.github/workflows/publish.yml:1`-`:5`). |
| W2.2 responsible-use docs + doctor warnings | partially-done | Responsible-use docs landed in `README.md:50`-`:85` and `docs/user/data-and-safety.md:84`-`:126`; spend docs are at `docs/user/data-and-safety.md:165`-`:174`. Doctor now surfaces crawl-politeness notices (`workers/automation/src/jobhunter/cli.py:2327`-`:2345`) and CapSolver config (`:2543`-`:2549`), with crawl regressions at `workers/automation/tests/test_crawl_politeness_config.py:83`-`:102`. Missing on `main`: W2.2 doctor rows for approval-gate-off and incomplete attestations, because W1.4 is not done and no CLI doctor row was found for those checks. |
| W2.3 local API / CSRF hardening | done | Loopback host, mutation origin/referer, `Sec-Fetch-Site`, and extension-token checks are enforced at `apps/api/src/server.ts:303`-`:341`. Passing matrix starts at `apps/api/test/server.test.ts:807`. Historical merge anchor: #268 / `5e5ee0e`. |
| W2.4 per-lane spend attribution + token ceilings | partially-done | P5 base exists: `llm_spend` day aggregate table (`workers/automation/src/jobhunter/database.py:184`-`:190`), daily-budget preflight (`workers/automation/src/jobhunter/llm.py:124`-`:156`), and budget regression `test_check_spend_budget_raises_non_retryable_budget_exceeded` (`workers/automation/tests/test_llm_spend_budget.py:73`-`:91`). Apply usage is recorded but unlaned (`workers/automation/src/jobhunter/infrastructure/apply/claude_code_cli.py:309`-`:317`; regression at `workers/automation/tests/test_claude_code_cli_adapter.py:141`-`:168`). W2.4 requires lane-attributed usage, per-lane token ceilings, owner-confirmed defaults, doctor visibility, and health-surface breakdown (`docs/plans/implemented/2026-07-03-oss-release-remediation-spec.md:1041`-`:1066`); those are not present in the current ledger/API shape (`workers/automation/src/jobhunter/llm.py:50`-`:57`). |
| W2.5 DCO / contribution governance | done | DCO workflow is present with owner exemption (`.github/workflows/dco.yml:1`-`:24`) and contributor docs require `Signed-off-by` for external PR commits (`CONTRIBUTING.md:37`-`:48`). Historical merge anchor: #269 / `1470bd3`. |
| W2.6 doctor Tier-2 auth chain | done | Setup probes cover Claude synthesis auth, Codex persisted auth, and Antigravity key/Vertex auth (`workers/automation/src/jobhunter/infrastructure/setup_probes.py:122`-`:180`, `:221`-`:236`, `:331`-`:351`). Passing regressions are `workers/automation/tests/test_setup_probes.py:26`-`:41`, `:61`-`:75`, `:83`-`:147`, and `workers/automation/tests/test_setup_synthesis_auth.py:42`-`:84`. User docs disclose the chain at `docs/user/getting-started.md:116`-`:128` and `docs/user/configuration.md:76`-`:108`. I0 anchors: #254 / `4223acf` and #317 / `7d6ad3d`. |

### 9.4 D-6 decision brief for guarded submission

#### §6.1 precondition checklist

| §6.1 precondition | Status | Anchors |
| --- | --- | --- |
| Phase 1 and Phase 2 are merged to `main` with QA `Gate: PASS` | partially-satisfied | R3 extension implementation is merged (#277, #281, #282). Current tests prove loopback-only manifest/source (`apps/extension/src/privacy.test.ts:13`-`:35`), built bundle runtime loopback calls (`apps/extension/src/privacy.e2e.test.ts:19`-`:46`, `:100`-`:115`), supported ATS detection (`apps/extension/src/ats.test.ts:5`-`:17`), and deterministic autofill behavior (`apps/extension/src/content-script.test.ts:36`-`:67`, `:170`-`:225`). A QA `Gate: PASS` artifact is not recorded in the tree. |
| Apply-safety hardening from the OSS spec is complete and merged | not-satisfied | W1.2-W1.7 are not done on the checked tree; see §9.2. |
| Extension security review (§8) completed/published and privacy-invariant test (§7) enforced in CI | partially-satisfied | Privacy-invariant tests exist (`apps/extension/src/privacy.test.ts:13`-`:35`; `apps/extension/src/privacy.e2e.test.ts:19`-`:46`), but no completed/published extension security review was found in the merged docs. |
| Release privacy gate green for extension package/archive | partially-satisfied | Release gate exists and runs scanner/self-test (`.github/workflows/release-check.yml:25`-`:29`); built extension privacy tests cover the dist package (`apps/extension/src/privacy.e2e.test.ts:19`-`:46`). This close-out did not independently run the extension package/archive privacy test suite; the PR verification runs the repository release scanner. |
| Explicit owner go/no-go D-6 | not-satisfied | Browser plan D-6 remains an open owner decision (`docs/plans/implemented/2026-07-05-browser-extension-plan.md:386`). |

#### §6.2 safety-substrate status

| Substrate | Status | Passing regression named |
| --- | --- | --- |
| Approval gate | present, but not enough to start R11 while W1 remains open | `test_apply_approval_gate_rejects_dry_run_evidence_for_stale_profile` (`workers/automation/tests/test_apply_regressions.py:539`) and `test_apply_approval_gate_rejects_invalid_partial_override` (`:588`). |
| CDP dry-run guard | present as a browser-layer guard, but W1.2 parser/invariant hardening is still not done | `test_dry_run_cdp_guard_blocks_hostile_employer_posts` (`workers/automation/tests/test_apply_chrome_dry_run_guard.py:55`). |
| At-most-once + `ApplySubmitIntended` | present | `test_double_start_returns_existing_handle_no_duplicate` (`workers/automation/tests/test_workflow_id_overlap.py:39`), `test_live_apply_workflow_does_not_retry_transient_failures` (`workers/automation/tests/test_workflow_apply.py:86`), and `test_live_saga_records_submit_intent_before_agent_result` (`workers/automation/tests/test_apply_saga.py:192`). Event type and process-manager anchors: `packages/domain-types/src/events/apply.ts:66`-`:82` and `workers/automation/src/jobhunter/domain/apply/process_manager.py:217`-`:225`. |
| Spend ceiling | base present; W2.4 per-lane delta incomplete | `test_check_spend_budget_raises_non_retryable_budget_exceeded` (`workers/automation/tests/test_llm_spend_budget.py:73`-`:91`). |

#### §6.3 boundary list (verbatim)

- Must not add a submission code path to the extension or content scripts.
- Must not weaken, flag-off, or bypass the approval gate, dry-run guard, at-most-once lifecycle, or spend cap.
- Must not submit as a side effect of capture or autofill.
- The extension's role is limited to handing a reviewed application to the supervised path and reflecting its status; the human `approve_submit` decision remains mandatory (I-2, I-3, BR-001, BR-023, BR-054).

#### Open D-6 risks

- **Apply prompt-injection posture:** still high-risk because the apply agent is a
  local Claude subprocess reading untrusted pages with `--permission-mode
  bypassPermissions` (`workers/automation/src/jobhunter/infrastructure/apply/claude_code_cli.py:149`-`:156`);
  the claims ledger itself says prompt injection is real and only limited, not
  removed (`docs/claims-ledger.md:141`).
- **D-4 generic matcher confirmation:** the starting ATS family set and rollout
  order remain owner-confirmed scope (`docs/plans/implemented/2026-07-05-browser-extension-plan.md:384`).
- **Partial-submission behavior:** W1.2 remains open; current dry-run parsing can
  still convert `RESULT:APPLIED` during dry-run into `DryRunComplete`
  (`workers/automation/src/jobhunter/infrastructure/apply/claude_code_cli.py:369`-`:376`).

#### Launch-copy consequence

- **Go later:** only after §6.1 is actually satisfied should ledger/comparison
  rows describe guarded submission as shipped/current, and every claim needs a
  pointer-backed row.
- **Wait now:** current decision is wait/no-go. Any guarded-submission or Phase 3
  row in the ledger/comparison/public launch copy must say **Roadmap** if it is
  post-launch. `docs/claims-ledger.md` was not edited in this close-out.

### 9.5 Remaining release owner-action checklist

W0.6, naming/rename, W2.4 disposition, comparison content, demo-asset scope,
Current-vs-Beta policy, claims-ledger ownership/location, and the shipped
browser-extension Phase 1/2 decisions are resolved. Browser-extension future
phases and the optional per-source policy editor remain product-roadmap choices,
not v2.0.0 release gates.

| Owner action | Source |
| --- | --- |
| Review the final honest crawl user-agent contact string before the authorized real TTFV crawls. | Crawl-politeness plan D1, "Owner decisions". |
| Re-stamp the already signed claims ledger against the final release `main` SHA. | `docs/claims-ledger.md`, "Freeze status" and GOV-04. |
| Record historical-blob acceptance and the deliberate live capability posture in the flip record. | OSS release spec §5, retained-history/capability-posture gate. |
| Complete the final human QA, including `jobctrl doctor`, the Apply Review gated-submit smoke, and blocked-channel harness evidence; no real applications. | OSS release spec §5, final manual QA gate. |
| Flip visibility, then immediately rerun Release Privacy, Docs Site, Python CI, Sync Homebrew Tap, and TypeScript CI on the exact `main` SHA. | Owner hosted-CI sequencing decision; `docs/publish-checklist.md` §9.1. |
| After hosted green, enable docs deployment, configure the exact `release-pypi.yml` Trusted Publisher, enable the release workflow, and publish the reviewed v2.0.0 GitHub Release. | `docs/publish-checklist.md` §§9.2 and 9.4. |
| At the v2.0.0 tag, add the stable Homebrew URL/SHA, merge its canonical formula update, verify tap sync, and run the stable install smoke. | `docs/publish-checklist.md` §9.5. |

## 10. Refreshed W1 residual inventory after remediation (2026-07-06)

### 10.1 Snapshot and decision

- **Tree checked:** `main` @ `660c4f22e64f0be13d7901584b399ba9fd364451`
  after the W1 remediation train merged (#336, #337, #338, #340, #342, #345).
- **Scope:** this section re-derives W1.2-W1.8 only. It supersedes the W1
  rows in §9.2 and §9.3; it does not claim the non-W1 release gates are done.
- **Read constraints honored:** no forbidden local-only planning documents were
  read or cited.
- **Decision:** W1 apply-safety hardening is **COMPLETE**. The overall R1
  release gate remains **NO-GO** because non-W1 release and owner checkpoints
  remain open; see §10.4.

### 10.2 W1 apply hardening status

| Item | Status | Evidence on `main` |
| --- | --- | --- |
| W1.1 approval bindings + partial-evidence gate | done | Unchanged from §9.2. Approval decisions bind material/profile/application state and reject stale partial overrides before a live submit. |
| W1.2 dry-run violation must fail closed | done | The apply adapter now converts `RESULT:APPLIED` during dry-run into non-retryable `dry_run_violation` instead of `DryRunComplete` (`workers/automation/src/jobhunter/infrastructure/apply/claude_code_cli.py:443`-`:448`), and the saga regression proves the violation records no dry-run completion evidence (`workers/automation/tests/test_apply_saga.py:486`-`:515`). Adapter coverage: `workers/automation/tests/test_claude_code_cli_adapter.py:354`-`:365`. |
| W1.3 reduce Claude permissions / owned MCP tools / env allowlist | done | The Claude subprocess now starts with explicit `--allowedTools`, `--disallowedTools`, `--no-session-persistence`, and filtered environment (`workers/automation/src/jobhunter/infrastructure/apply/claude_code_cli.py:210`-`:227`, `:495`-`:500`). The allowlist excludes unsafe Playwright/Gmail tools and includes only owned apply tools (`:47`-`:100`, `:486`-`:492`). Regressions prove no permission bypass, no secret env forwarding, and pinned allowlist parity (`workers/automation/tests/test_claude_code_cli_adapter.py:167`-`:220`, `:298`-`:321`). |
| W1.4 remove hardcoded legal attestations | done | The apply prompt now renders only typed profile `application_attestations` and requires `RESULT:FAILED:missing_profile_data:<field>` for required missing legal/screening facts (`workers/automation/src/jobhunter/apply/prompt.py:78`-`:82`, `:210`-`:217`). Prompt tests prove hardcoded defaults are absent and typed attestations render explicitly (`workers/automation/tests/test_apply_prompt_builder.py:196`-`:206`, `:209`-`:235`). |
| W1.5 keep profile password out of prompt | done | The prompt tells the agent to focus the password field and call `type_credential(kind="job_site_password")`, never to ask for, print, or type the password itself (`workers/automation/src/jobhunter/apply/prompt.py:455`). The owned MCP tool resolves and types the credential without returning it (`workers/automation/src/jobhunter/infrastructure/apply_tools/mcp_server.py:112`-`:125`), and tests prove the secret is not returned or rendered (`workers/automation/tests/test_apply_tools_mcp_server.py:79`-`:97`, `workers/automation/tests/test_apply_prompt_builder.py:196`-`:203`). |
| W1.6 keep CapSolver key out of prompt | done | CAPTCHA handling is now an owned `solve_captcha` tool that requires a configured key server-side and never returns provider keys or solver tokens (`workers/automation/src/jobhunter/infrastructure/apply_tools/mcp_server.py:127`-`:145`, `:216`-`:235`). The prompt tells the agent to call `solve_captcha` for supported widgets and fail closed otherwise (`workers/automation/src/jobhunter/apply/prompt.py:268`-`:269`, `:486`). Tests prove no key in prompt/config exposed to the model, key-scoped tool availability, fail-closed missing-key behavior, and no secret leakage in usage events (`workers/automation/tests/test_apply_prompt_builder.py:196`-`:199`, `:277`-`:292`; `workers/automation/tests/test_apply_tools_mcp_server.py:152`-`:199`, `:201`-`:215`). |
| W1.7 quarantine email application sending | done | The agent can only report a page-visible recipient as `RESULT:EMAIL_ONLY:<address>` (`workers/automation/src/jobhunter/apply/prompt.py:450`; parser at `workers/automation/src/jobhunter/infrastructure/apply/claude_code_cli.py:437`-`:439`). The saga verifies the recipient against stored posting text, records `EmailApplicationCandidateRecorded`, blocks dry-run sends with `blocked_channels=("email_application",)`, requires a matching Apply Review decision before live send, and sends only through the owned email sender (`workers/automation/src/jobhunter/domain/apply/process_manager.py:451`-`:489`, `:501`-`:526`). Regressions prove unverified recipients are rejected, dry-runs never send, approval binding is required, and missing send scope fails closed (`workers/automation/tests/test_apply_saga.py:360`-`:430`, `:480`-`:483`). |
| W1.8 dry-run-by-default surface defaults | withdrawn | Owner decision #328 removed W1.8 from the release plan. Live/non-dry-run remains the default unless callers pass `--dry-run` / `dryRun: true`; W1.8 is not a release requirement, gate, or acceptance criterion. |

### 10.3 Verification gates for the W1 train

The W1 train was validated locally with the repository gate, independent of
GitHub CI status:

- `corepack pnpm check` — passed.
- `corepack pnpm test` — passed: API Vitest, web build, extension unit/e2e, and
  Python pytest (`2002 passed, 1 warning`).
- `corepack pnpm --filter @jobhunter/web test` — passed (`169` files,
  `998` tests).
- `uv --project workers/automation run --extra dev pytest -q` — passed
  (`2002 passed, 1 warning`).
- `uv --project workers/automation run --extra dev ruff check .` — passed.
- `corepack pnpm docs:build` — passed (`4705` references across `233` files).
- `python3 scripts/release_check.py --strict-prompt` and
  `python3 scripts/release_check.py` — passed.
- `git diff --check`, local-only-doc touch scan, added-line competitor-name
  scan, and conflict-marker scan — clean.

### 10.4 Current release gate

The W1 apply-safety hard precondition is now satisfied. Overall R1 is still
**NO-GO** until at least these non-W1 release gates close:

W0.6 is no longer a current blocker: owner review closed it as passed on
2026-07-07, with private disposition details kept off-repo.

| Gate | Current status | Evidence |
| --- | --- | --- |
| W2.1 distribution rename and guarded publishing path | complete | The distribution is `jobctrl`; the historical workflow is gone; `release-pypi.yml` is release-only, exact-main/tag/version gated, and remains disabled pending the owner release action. |
| W2.4 per-lane token ceilings | explicitly deferred | Owner written decision 2026-07-10: v2.0.0 retains the global estimated daily USD ceiling; per-lane attribution, token ceilings, apply accounting, and lane visibility remain backlog. |
| Hosted release gates | pending post-public rerun | Private-repository jobs fail before running because of GitHub billing. The owner-approved sequence is local full green → visibility flip → immediate hosted rerun; docs, tag, and publication remain blocked until green. |
| Final release/visibility owner actions | not complete | §9.5 still requires the owner-only release flip, post-public workflow readback, first tag, and final sign-offs. |

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
