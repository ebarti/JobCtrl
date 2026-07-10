# OSS Release Remediation — Implementation Spec for Codex

> **Status (2026-07-05 R1 closeout):** archived after #274 regenerated the
> inventory against current `main`; that first closeout was **not** a
> release-ready outcome. The 2026-07-06 W1 refresh in
> `2026-07-05-oss-release-drive-to-done-plan.md` supersedes that W1 snapshot:
> W1.1-W1.7 are complete and W1.8 is withdrawn. Non-W1 release/owner
> checkpoints remain open, so do not treat the move to `implemented/` as proof
> that the OSS release gate passed.
>
> **W0.6 owner pass (2026-07-07):** owner review closed the W0.6 disposition
> gate as passed. Private concern details remain off-repo; no W0.6 accepted-risk
> entry remains a release blocker.
>
> **Owner release decisions (2026-07-10):** the first public release is
> **v2.0.0**. W2.4 is explicitly deferred for that release: v2.0.0 keeps P5's
> application-wide estimated daily USD ceiling and preflight, while per-lane
> token attribution, per-lane ceilings, apply-lane accounting, and lane-level
> doctor/health visibility remain an acknowledged backlog item. This is a
> written deferral, not a claim that W2.4 was implemented.
>
> **Owner hosted-CI sequencing decision (2026-07-10):** GitHub currently
> refuses to start private-repository jobs because of the account billing
> state. After the exact release tree passes the complete local gate, the owner
> will flip the repository public and immediately rerun Release Privacy, Docs,
> Python, Homebrew sync, and TypeScript workflows. Docs deployment, release
> tagging, and package publication stay blocked until those runs are green; a
> failed privacy run requires an immediate return to private while it is
> investigated. No failed zero-step run is treated as passing evidence.
>
> **Owner decision (2026-07-06):** the W1.8 dry-run-by-default requirement is
> withdrawn. `jobhunter apply` and workflow/RPC apply starts keep the existing
> non-dry-run default unless the caller passes `--dry-run` / `dryRun: true`.
> W1.8 is no longer a release requirement, gate, or acceptance criterion.
>
> **Audience:** an external implementing agent (Codex). This document is
> self-contained and prescriptive: follow it literally. Where it says STOP,
> stop and report rather than improvising.
> **Companions:** `docs/plans/implemented/2026-07-03-temporal-native-rearchitecture.md`
> (PR #230, the architectural plan) and
> `docs/plans/implemented/2026-07-03-temporal-rearch-implementation-spec.md` (PR #232,
> the P1b–P5 implementation spec). Workstream W1 below **builds on top of
> temporal phase P2** and must not re-implement anything P2 delivers.
> **Goal:** make this repository safe to publish as open source while
> preserving every existing capability: live application submission,
> CapSolver-based CAPTCHA solving, email applications, LinkedIn/Indeed
> discovery boards, AGPL-3.0-only licensing, and the existing git history.
> Compliance posture is disclosure and hard operator gates, not capability
> removal.

---

## 0. How to use this document

1. Implement exactly ONE work item (W0.x / W1.x / W2.x) per pull request,
   in the dependency order of §0.1. Never combine items.
2. Before every edit, locate the anchor **by symbol name** (grep/ripgrep).
   Line numbers in this doc are hints captured 2026-07-03 and WILL have
   drifted. If a named symbol does not exist, STOP and report — do not
   guess, do not create a lookalike.
3. Each work item has: Objective, Preconditions, Branch/PR names, Files you
   may touch, Work Items, Tests, and a binary **Definition of Done**
   checklist. An item is complete only when every Definition of Done entry
   is checked and every verification command passes with the stated result.
4. Rip-and-replace is the standing rule: when an item replaces a legacy
   path, delete the legacy path in the same PR. No compatibility shims, no
   feature flags guarding old-vs-new, no "deprecated" wrappers.
5. If a required change appears to force edits outside the item's scope,
   STOP and report the conflict instead of expanding scope.
6. **Owner decision checkpoints** (§0.5) are places where you must STOP,
   present options, and wait for the owner's choice before proceeding.

### 0.1 Ordering: per-item gates against the PR #232 program

The temporal program (single stacked run P1b → P3 → P2 → P4 → P5, per the
PR #232 spec) is in flight with unknown per-phase delivery dates. Do NOT
branch from its unmerged stack. Every item below carries a **Gate** — what
must have MERGED TO `main` before you cut the item's branch. Gate `none`
means: start now, from `main`, in parallel with the temporal run.

| Item | Gate | Collision with #232 (type) |
| --- | --- | --- |
| W0.1–W0.6 | none | Only W0.2's fixture-data swaps touch files P2/P3/P4 also edit — data-only, trivial rebase. |
| W1.1, W1.2, W1.3→W1.5→W1.6, W1.7 | temporal **P2** | Same files AND same semantics: they extend P2's gate/guard/intent/`needs_verification` substrate. |
| W1.4 | temporal **P2** (soft — see note) | Semantically independent of P2; only file contention (`packages/contracts`, adapter result parse, apply-review UI). |
| W2.2 (docs), W2.5 | none | Disjoint. (P5 also edits `README.md`/`docs/**` — different sections, trivial.) |
| W2.3 | PR **#233** (P0) | Same `server.ts`; P2 later touches other regions of it (trivial contention). |
| W2.4 | temporal **P5** | P5 SHIPS the base spend system (`llm_spend`, `dailyBudgetUsd`, `check_spend_budget` preflight, dual-client recording). W2.4 is a delta on it — see the rewritten §W2.4. |
| W2.6 + doctor parts of W2.2 | temporal **P5** | `cli.py` is P5-owned; P4 rewrites `discovery/**` including the board-fallback seams the doctor warning must reflect. |

W1.4 note: if P2 is badly delayed, W1.4's core (prompt attestation
removal + profile contract) MAY be pulled forward from `main` at the cost
of one temporal-stack rebase — an owner call, not the default.

Sequencing summary:

```
now         ──► W0.1→W0.2→W0.5→W0.3→W0.4→W0.6   (first: privacy CI gates every later PR)
            ──► W2.2(docs), W2.5                  (fully parallel)
#233 merged ──► W2.3
P2 merged   ──► W1.1→W1.2→W1.3→W1.4→W1.5→W1.6→W1.7  (stacked; do NOT wait for P4/P5)
P5 merged   ──► W2.4, W2.6, W2.2(doctor)
all merged  ──► §5 release flip
```

- W0 lands first; the temporal stack rebases once after W0 merges.
- **W1.1–W1.7 unblock at P2, not P5.** P4/P5 touch almost none of their
  files; the residual contention (P5 adds `dailyBudgetUsd` to
  `packages/contracts` and the settings form) is a trivial rebase for the
  temporal stack as W1 items land on `main`.
- The critical path to the release flip runs through P5 only via W2.4, W2.6,
  and doctor warnings.
- **If the entire PR #232 program is already delivered**, every gate is
  satisfied and nothing else changes: W0 first (the privacy CI gate is
  still wanted under every later PR), then W1.1→W1.7 as one stacked
  series with W2 fully parallel, then §5. Optional intra-W1 parallelism
  in that world: lane {W1.1→W1.2→W1.7} (claim/review/recovery) alongside
  lane {W1.3→W1.4→W1.5→W1.6} (adapter/prompt/owned tools), converging on
  W1.7. Prefer the single stacked series unless two implementers actively
  coordinate.
- Naming and PyPI publishing are out of scope for this program — deferred
  to the owner's pre-publication rename train (§1 "Naming", updated
  2026-07-05).

### 0.2 Non-negotiable ground rules

- **Never edit code on `main`; never leave `main` dirty.** Each item on its
  own branch in its own worktree, cut from up-to-date `main` (or from the
  predecessor branch for stacked W1 items).
- Conventional Commits for every commit and PR title.
- Never commit: SQLite databases, `*.pdf`, resumes, cover letters, browser
  profiles, logs, `worker/` runtime dirs, API keys, `profile.json`.
- Never run: `jobhunter apply` against real sites, auto-apply, real browser
  submission, real mailbox scans, destructive DB commands. All apply-path
  testing uses the unit/integration harnesses described below.
- **This document and every file you create are public.** Never write the
  owner's personal identity strings (name, username, personal domain,
  LinkedIn slug, résumé content, real employer names used as owner
  evidence) into any file, commit message, or PR text. The ONLY permitted
  location for those literals is the obfuscated needle list inside
  `scripts/release_check.py` (which excludes itself from scanning). When
  this spec needs to reference such a string it does so by file/line
  pointer; read the value at the pointer, use it in the needle list, and
  never echo it anywhere else.
- Never weaken, skip, or delete a parity or exhaustiveness test
  (`every-event-has-handler.test.ts`, `every-stage-state-has-badge.test.tsx`,
  type-level enum tests). When one fails it is doing its job: fix the
  registry/handler/badge, not the test.
- Any new domain event type lands in BOTH registries
  (`workers/automation/src/jobhunter/domain/events/__init__.py` and
  `packages/domain-types/src/events/index.ts`) plus a web invalidation
  handler plus web fixtures, in the same PR — copy the pattern the P0
  `Workflow*` family used.

### 0.3 Verification command matrix

Run the commands for every surface you touched; the full sweep before
opening the PR.

| Surface | Commands | Required result |
| --- | --- | --- |
| Python worker | `uv --project workers/automation run --extra dev pytest -q` | 100% pass |
| Python lint | `uv --project workers/automation run --extra dev ruff check .` | `All checks passed!` |
| Python package | `uv --project workers/automation run --extra dev python -m build workers/automation` | builds clean |
| TS API | `pnpm api:check` then `pnpm api:test` | zero errors / all pass |
| API QA harness | `pnpm qa:test` | all pass |
| Web | `pnpm web:check`, `pnpm --filter @jobhunter/web test`, `pnpm --filter @jobhunter/web test-d` | zero errors / all pass |
| Full check | `pnpm check` | zero errors |
| Full sweep (pre-PR, always) | `pnpm test` | all pass |
| Privacy (always, from W0.3 onward) | `python3 scripts/release_check.py` | **zero findings** |
| Hygiene | `git diff --check` | clean |

### 0.4 PR / completion report template

Every PR description must contain: **What** (bullet list of changes incl.
deletions), **Why** (one paragraph referencing this spec's item), 
**Validation** (every §0.3 command you ran, verbatim, with its exact
result), **Deviations** (empty section if none), **Deferred** (anything
explicitly left out, with the item it was routed to). PR text must be
PII-clean per §0.2.

### 0.5 Owner decision checkpoints (STOP and ask)

1. **W2.1** — removed 2026-07-05; naming and publishing are deferred to
   the owner's pre-publication rename train (§1 "Naming"). No checkpoint
   remains. (Number retained so §0.5.2–.4 references stay stable.)
2. **W2.4** — resolved 2026-07-10 by explicit owner deferral for v2.0.0.
   The existing global estimated-USD ceiling remains; per-lane attribution,
   token ceilings, apply-lane accounting, and lane visibility stay in the
   engineering backlog.
3. **W0.6** — any CONCERNS item you propose to classify as
   "accepted risk" (the owner must approve each acceptance). Closed on
   2026-07-07 with no accepted-risk entry remaining as a release blocker.
4. **§5** — the actual repository visibility flip and first release tag are
   owner-only actions; you prepare, you never execute them.

---

## 1. Locked owner decisions (do not re-litigate)

- **Preserve all capabilities.** Live submit, CapSolver solving (env-gated,
  off by default), email applications (rebuilt as a controlled owned-send
  path in W1.7), LinkedIn/Indeed in the default discovery boards.
  Compliance is achieved via hard approval gates, disclosure documentation,
  and operator-explicit opt-ins — not removal.
- **License:** AGPL-3.0-only stays. **Contributor policy:** DCO (W2.5).
- **Git history is kept.** The current tree is scrubbed (W0); the owner
  accepts that historical blobs remain technically reachable. This
  acceptance is recorded at the release gate (§5). The W0.6 disposition
  gate exists because one historical artifact is security-relevant, not
  merely private.
- **Naming (updated 2026-07-05, supersedes the original W2.1 plan):** the
  product's final name is `JobCtrl`. The full rename — repo name, product
  strings, console script, PyPI distribution name `jobctrl`, docs sweep —
  is an owner-executed rename train that lands AFTER every W-item and
  BEFORE the visibility flip, deliberately last because a rename
  invalidates the path/symbol anchors this spec navigates by. Until that
  train lands: the repo, product strings, import package `jobhunter`, and
  `jobhunter` console script all stay unchanged, no W-item renames
  anything, and nothing is published to PyPI (`publish.yml` stays
  `workflow_dispatch`-only under the W0.3 structural guard).

---

## 2. Workstream W0 — Privacy and release hygiene (from `main`, first)

### W0.1 — Untrack the private planning corpus

**Objective:** the tracked `.planning/` tree (143 files of internal
milestones, research, and codebase notes) leaves the public tree; private
skill banners leave `docs/plans/implemented/`.

**Branch:** `chore/w0-1-untrack-planning` ·
**PR title:** `chore(release): untrack private planning corpus and strip private banners`

Work items:
1. `git rm -r --cached .planning/` (files stay on disk for the owner). Add
   `.planning/` to `.gitignore`.
2. Grep `docs/plans/implemented/` for the private skill-banner prefix
   (search for lines containing `superpowers`); six files open with such
   banner lines. Delete the banner lines only; keep the document bodies.
3. Confirm no other tracked file references `.planning/` paths in a way
   that breaks (docs links etc.); fix any dangling references.

**Definition of Done**
- [ ] `git ls-files | grep -c '^\.planning/'` prints `0`.
- [ ] `.gitignore` contains `.planning/`.
- [ ] `grep -rn "superpowers" docs/` prints nothing.
- [ ] Full sweep (§0.3) passes.

### W0.2 — Scrub owner PII from tracked fixtures and tests

**Objective:** every tracked file is free of the owner's personal identity
and résumé-derived content. Swap data only — never delete a test, never
weaken an assertion.

**Branch:** `chore/w0-2-scrub-fixtures` ·
**PR title:** `chore(release): replace owner-derived fixture data with synthetic equivalents`

**Work item 0 — capture the needle inventory FIRST.** Before replacing
anything, record the exact forbidden values present at the leak sites
below (owner identity strings, the two employer names used as owner
evidence, the seed marker, private path fragments) into a private
OFF-REPO needle inventory at the same owner-designated location as the
W0.6 artifact (e.g., the untracked local `.planning/`). W0.3 consumes
this inventory to build its needle list. Never commit it; never post it
in PR/issue text (§0.2). Fallback if the inventory is ever lost: harvest
from the pre-W0.2 parent commit via git history (`git show
<pre-W0.2-commit>:<path>` — history is kept per §1).

Known leak sites (line numbers are hints; each file must be fully re-read
and scrubbed, not just at the hinted line):
1. `apps/web/src/shared/ui/PdfPreviewViewer.test.ts` — embeds an
   effectively complete real résumé (identity, employer names, role
   history, location-specific bullet content). Replace with a synthetic
   résumé of comparable length/structure for a fictional person at
   fictional employers so the rendering assertions keep exercising the same
   shapes.
2. `apps/web/src/views/apply-review/ApplyReviewView.test.tsx` (~:2077–2078
   plus one additional real-employer block elsewhere in the file) — real
   contact card and employer references → synthetic.
3. `apps/api/test/application-feedback.test.ts` (~:518),
   `apps/api/test/resume-review-drafts.test.ts` (~:529, :658, :721),
   `apps/api/test/server.test.ts` — owner name used as fixture values →
   synthetic names.
4. `apps/web/src/test/msw/handlers.ts` (~:642) — résumé HTML mock contains
   the owner name → synthetic.
5. `workers/automation/tests/test_bullet_provenance.py`,
   `workers/automation/tests/test_requirement_led_tailoring.py`,
   `workers/automation/tests/test_content_validator.py` — owner-evidence
   résumé strings → synthetic.
6. `workers/automation/tests/test_enrichment_snapshot_pr3.py` — a lowercase
   `user:` + owner-username seed marker → `user:example`.

**Definition of Done**
- [ ] The private needle inventory exists at the owner-designated
      location and covers every value class scrubbed below.
- [ ] Every file above (and any additional hit found by the W0.3 scanner
      run locally against your branch) contains only synthetic data.
- [ ] No test was deleted; no assertion was weakened; suite counts did not
      decrease.
- [ ] Full sweep (§0.3) passes.

### W0.3 — `release_check.py` v2

**Objective:** the release scanner catches the classes of leak that
actually occurred, not just four exact-case tokens, and is itself tested.

**Branch:** `feat/w0-3-release-check-v2` ·
**PR title:** `feat(release): broaden release_check needles, file-type checks, and add a self-test`

**Ordering:** stacks on W0.5, not W0.2 — item 7 fails on any tree where
the tag trigger is live under the blocked distribution name, which
includes the post-W0.2 tree. Section numbers are stable IDs, not
sequence; see §0.1 and the W0.5 ordering note.

Work items:
1. **Case-insensitive identity matching.** All identity needles match
   case-insensitively.
2. **Needle classes** (literal values live ONLY inside
   `scripts/release_check.py`, using the existing string-concatenation
   obfuscation): the existing FORBIDDEN_TEXT list, plus — sourced from
   the private needle inventory W0.2 captured before scrubbing
   (fallback: the pre-W0.2 parent commit via git history; the values are
   no longer in the working tree) — the owner first name, full
   name, username, personal domain, LinkedIn profile slug, the two real
   employer names that appear as owner evidence in the leaked fixtures, the
   lowercase seed-marker token, private local-toolchain path fragments (the
   owner's absolute home-directory prefix and private agent-runtime/skill
   directories), and the private skill-banner prefix.
3. **Collision rule:** the public maintainer byline (the GitHub handle in
   `package.json` / `pyproject.toml` / README author fields) is intended
   and allowed. Do NOT add the bare surname or the GitHub handle as
   needles. Add a unit test asserting the scanner passes on
   `package.json`, `pyproject.toml`, and `README.md` as they exist after
   W0.2.
4. **File-type flags:** extend the name scan to flag tracked `*.sqlite`,
   `*.sqlite3`, `*.db-wal`, `*.db-shm`, `*.pdf`, `*.docx`, `*.log`,
   `*.har`, `*.pem`, `*.key`, `token.json`, and known browser-profile
   directory names.
5. **Text coverage:** add `.sql`, `.csv`, `.xml`, `.svg` to
   `TEXT_SUFFIXES`.
6. **Secret patterns:** generalize the env-assignment check from the
   current four keys to any `*_API_KEY` / `*_SECRET` / `*_TOKEN` /
   `*_PASSWORD` assignment with a non-placeholder literal value in
   env-like, JSON, YAML, and TOML files. Keep the existing placeholder
   allowances. Do not flag code that merely *reads* such variables.
7. **Structural checks:** fail if any tracked path starts with
   `.planning/`; fail if `.github/workflows/publish.yml` has an enabled
   tag trigger while `workers/automation/pyproject.toml` still declares the
   PyPI-blocked distribution name. W0.5 lands before this item, so the
   check is green on arrival; it exists to prevent a silent re-enable and
   is retired by the pre-publication rename train (§1 "Naming"). Do not
   soften it with a bypass flag.
8. **Source tripwires** (pinned to specific files): fail if
   `workers/automation/src/jobhunter/apply/prompt.py` interpolates the
   CapSolver key env var into prompt text, contains the hardcoded
   attestation-default block (the literal `Felony:` / `Age 18+:` default
   lines), or interpolates the profile password. These start red-on-main
   and go green as W1.4/W1.5/W1.6 land — therefore gate them behind a
   `--strict-prompt` flag that the CI workflow (W0.4) only enables once W1
   completes; run findings as warnings until then. Document the flag in
   the script header.
9. **Self-test:** make the needle list injectable; add a test (pytest,
   under `workers/automation/tests/` or a `scripts/` test wired into CI)
   that builds a temp tree containing one synthetic violation per class
   and asserts each is caught, and that a clean temp tree passes. The
   self-test must not contain real needles.
10. Non-zero exit code on findings (verify; keep).

**Definition of Done**
- [ ] `python3 scripts/release_check.py` exits 0 with zero findings on the
      post-W0.5 tree, and non-zero when any self-test violation is
      introduced.
- [ ] Byline collision test passes.
- [ ] Self-test runs in the Python test suite.
- [ ] Full sweep (§0.3) passes.

### W0.4 — Unfiltered privacy CI gate

**Objective:** the privacy scan runs on every push and PR with no path
filters, so no change can dodge it.

**Branch:** `ci/w0-4-privacy-gate` ·
**PR title:** `ci(release): run release_check on every push and PR without path filters`

Work items: add `.github/workflows/release-check.yml`: triggers `push`
(main) + `pull_request` (all), no `paths:` filters; sets up Python; runs
`python3 scripts/release_check.py` and the W0.3 self-test. Existing
Python/TS CI workflows keep their path scoping.

**Definition of Done**
- [ ] Workflow file present, green on the branch.
- [ ] A deliberate scratch commit adding a synthetic violation (pushed to
      the PR branch, then reverted within the same PR) shows the check
      failing in CI — link both runs in the PR description.

### W0.5 — Disable tag publishing until rename

**Objective:** no accidental PyPI publish before the pre-publication
rename train (§1 "Naming"; originally gated on W2.1).

**Branch:** `ci/w0-5-guard-publish` ·
**PR title:** `ci(release): disable tag publishing until distribution rename`

**Ordering:** lands immediately after W0.2 and BEFORE W0.3, out of
numeric order. W0.3 item 7 fails whenever the tag trigger is live under
the blocked distribution name — true of the tree today — so the trigger
must be disabled first for W0.3's exit-0 DoD to be satisfiable; landing
this first also closes the accidental-publish window sooner. Do not
resolve the conflict the other way (a bypass flag on item 7): the item-8
`--strict-prompt` pattern is reserved for tripwires whose fix is gated on
W1, and this one's fix is the two-line edit right here.

Work items: change `.github/workflows/publish.yml` trigger to
`workflow_dispatch` only, with a header comment pointing at the
pre-publication rename train (originally W2.1). The W0.3 structural check
(landing next in the stack) enforces this cannot silently revert.

**Definition of Done**
- [ ] No `push`/tag trigger remains in `publish.yml`.
- [ ] `python3 scripts/release_check.py` passes (v1 at this point in the
      stack).

### W0.6 — CONCERNS disposition gate

**Objective:** the internal codebase-concerns document (now untracked, on
disk at `.planning/codebase/CONCERNS.md`) maps known weaknesses with file
locations. Because history is being kept, that map remains reachable in
old commits. Every item in it must be dispositioned before the repo goes
public.

**Branch:** `docs/w0-6-concerns-dispositions` ONLY if dispositions add
sanitized `docs/backlog.md` entries; otherwise no branch — the table is
not a code change.

Work items: for every numbered concern in the file, record exactly one
disposition: **fixed** (link the commit/PR), **fixed-by** (link the W1/W2
item that fixes it), **public-backlog** (add a sanitized entry to
`docs/backlog.md` — no exploit detail, no file-located vulnerability
descriptions), or **accepted** (owner approval required per §0.5.3). The
disposition table is a PRIVATE, off-repo owner artifact: write it into
the now-untracked local `.planning/` directory (or wherever the owner
designates). It must NOT be committed, and it must NOT be posted in PR
comments, PR descriptions, or issues — all of those become public
surface when repository visibility flips. The only public traces are the
sanitized backlog entries, links to fixing PRs, and the §5 checklist
line stating dispositions are complete.

**Definition of Done**
- [ ] Every concern has exactly one disposition; none is silently dropped.
- [ ] All "fixed-by" references point at real items in this spec.
- [ ] Owner has approved every "accepted" entry.
- [ ] No concern-derived content appears in any committed file, PR text,
      or issue — the table lives only at the owner's private location.

---

## 3. Workstream W1 — Apply and runtime safety (gated on temporal P2)

### W1.0 Substrate check (run before W1.1; STOP if any is missing)

Temporal P2 (see PR #232 spec §5) must already be MERGED TO `main` and
provide:
- `applyApprovalRequired` setting plumbed end-to-end (default `true`),
  enforced by an `approve_submit` SELECT inside `acquire_job`'s
  `BEGIN IMMEDIATE` transaction.
- `ApplySubmitIntended` event in both registries; intent-aware recovery
  with the `needs_verification` state (reaper #3 deleted).
- Browser-layer dry-run guard in `apply/chrome.py` (CDP `Fetch`
  interception + `Page.addScriptToEvaluateOnNewDocument` form-submit
  override, auto-attach to new targets).
- Evidence artifacts (`apply_agent_output`, `apply_confirmation`) and
  derived `verification_confidence`.

W1 **extends** these. If you find yourself re-implementing one, STOP.

### W1.1 — Approval freshness binding

**Objective:** an `approve_submit` decision is only valid for exactly what
the human reviewed: the materials generation, the profile version, the
application URL — and only after dry-run evidence exists (or an explicit
partial-evidence override).

**Branch:** `feat/w1-1-approval-binding` ·
**PR title:** `feat(apply): bind approvals to materials/profile/URL and dry-run evidence`

Work items:
1. **Capture bindings at decision time.** Extend the decision write path
   (`recordApplyReviewDecision`, `apps/api/src/application-feedback.ts`
   ~:357, route in `apps/api/src/server.ts` ~:983) so an `approve_submit`
   row records: the materials generation identifier the review displayed,
   the current profile version, and the job's application URL. If no
   monotonic profile version exists yet, add one at the profile write
   layer (single integer bumped on every profile mutation, persisted
   beside the profile) — locate the owning writer, do not scatter bumps.
   Migration: `ALTER TABLE application_review_decisions ADD COLUMN`s,
   nullable; register DDL in `init_db`'s ensure-block.
2. **Stale-by-default for legacy rows.** A live claim treats an
   `approve_submit` row with NULL bindings as stale (re-approval
   required). Single-user rip-and-replace: no grandfathering.
3. **Claim-time predicate.** Extend the P2 gate SELECT (still inside
   `BEGIN IMMEDIATE`): claim a LIVE run only when the latest decision is
   `approve_submit` AND its bound materials generation equals the job's
   current one AND bound profile version equals current AND bound URL
   equals the job's current application URL AND dry-run evidence holds:
   EITHER a dry-run completion with `coverage = "full"` exists for that
   same materials generation and URL, OR the decision row's
   `partial_override_run_id` references a specific dry-run run that
   exists with `coverage = "partial"` for that same materials generation
   and URL. An override that references no run, a missing run, or a run
   for stale materials/URL is INVALID — the override weakens "full" to
   "partial"; it never waives dry-run evidence entirely. Record distinct
   skip reasons in the existing skip channel: `awaiting_approval`,
   `awaiting_dry_run`, `approval_stale_materials`,
   `approval_stale_profile`, `approval_stale_url`,
   `override_evidence_invalid`.
4. **Partial override.** New nullable column `partial_override_run_id` on
   the decision row (the dry-run run id accepted as evidence — not a
   boolean), settable only through an explicit UI affordance on the
   approve action ("Approve with partial dry-run evidence"). The
   affordance is offered ONLY when a partial-coverage dry-run exists for
   the current materials generation; it displays that run's
   blocked-channel evidence and renders a persistent `role="alert"`
   warning naming what was not verified. Never set implicitly.
5. **UI.** The apply-review approval card shows what is being bound
   (materials generation, dry-run evidence status/coverage, URL) and the
   skip reasons from item 3 when a claim was refused.

Tests: one claim fixture per predicate arm (no approval / no dry-run /
each staleness dimension / valid / valid-with-override /
override-referencing-no-run refused / override-bound-to-stale-run
refused); API test that the decision write captures bindings; component
test for the override affordance gating and its warning.

**Definition of Done**
- [ ] A live claim is impossible without a fresh, fully-bound approval —
      proven by the per-arm pytest fixtures.
- [ ] Regenerating materials or mutating the profile invalidates a prior
      approval (fixtures prove both).
- [ ] An approval whose override references no matching partial dry-run
      run cannot claim (fixtures prove it).
- [ ] Skip reasons visible in apply-review.
- [ ] Full sweep (§0.3) passes, including `pnpm qa:test`.

### W1.2 — Dry-run guard hardening and honest outcomes

**Objective:** the P2 guard becomes airtight and its evidence becomes
first-class: blocked channels are recorded, coverage is classified,
violations are never relabeled as success, and live mode gains
per-request intent breadcrumbs.

**Branch:** `feat/w1-2-dryrun-guard-hardening` ·
**PR title:** `feat(apply): dry-run coverage classification, violation outcomes, live-mode breadcrumbs`

Work items:
1. **Interception policy — replace P2's wholesale.** The temporal plan
   and spec texts differ on P2's scoping (application-origin vs any
   non-localhost host); regardless of which shipped, W1.2 replaces the
   policy: during dry-run, allow ONLY `GET` and `HEAD`; block every
   other method (`POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, anything
   nonstandard) to EVERY origin, from every frame and every
   auto-attached target. ATS flows hop origins via redirects, iframes,
   and vendor domains — origin scoping is bypassable by design. There
   is NO exemption — not even localhost/127.0.0.1 (P2's carve-out is
   removed): the test harness only needs to SERVE pages, which is GET;
   mutating page-origin requests to localhost-bound services are
   blocked and recorded like any other, and the harness asserts
   non-receipt precisely because the guard blocks them.
2. **DOM layer + WebSocket.** Extend the injected script to also wrap
   `navigator.sendBeacon` (return `false`) and the `window.WebSocket`
   constructor (throw + report — blocking creation beats wrapping
   `send`) during dry-run, reporting through a `Runtime.addBinding`
   channel rather than a window flag. Because document-injected scripts
   do not reach dedicated workers, additionally listen for CDP
   `Network.webSocketCreated` on every auto-attached target as a
   backstop reporter: any WebSocket observed during dry-run is recorded
   in the blocked-channel evidence and demotes coverage (item 4).
3. **Blocked-request evidence.** Persist every blocked request (method,
   URL origin+path only — strip query strings, they can carry PII —
   frame, CDP resourceType, timestamp) into a `job_artifacts` row of
   kind `apply_dryrun_blocked` (JSON list), one row per run.
4. **Coverage classification.** `DryRunComplete` gains
   `coverage: "full" | "partial"`. Classify by CDP `resourceType`, not
   by origin (ATS steps legitimately cross origins): `partial` when any
   blocked request had resourceType `Document`, `XHR`, or `Fetch` —
   from ANY origin — or any DOM-submit/WebSocket interception fired
   before the final page. Blocked `Ping`/`Beacon`/`Image`/analytics
   resource types do NOT demote coverage. Contracts + Python mirror +
   web ripple (the dry-run evidence card shows coverage and the
   blocked-channel list).
5. **Violation outcome.** Delete the coercion in
   `apply/claude_code_cli.py` (~:354–361) that maps `RESULT:APPLIED`
   during dry-run to `DryRunComplete`. Replace with a distinct
   `dry_run_violation` outcome: apply stage → `failed` with reason
   `dry_run_violation`, an event is recorded, and apply-review renders it
   as a red violation (the network layer guarantees nothing was
   transmitted; the violation records that the agent attempted it —
   that's an injection/prompt-quality signal, not a success).
6. **Live-mode breadcrumbs.** Run the interceptor in live mode too, in
   observe mode: before `Fetch.continueRequest` of ANY mutating request
   — every method except GET/HEAD, every origin, every frame/target —
   append a durable breadcrumb (run id, method, origin+path,
   resourceType, timestamp), committed synchronously. The coarse P2
   `ApplySubmitIntended` remains the recovery trigger; breadcrumbs
   refine it in ONE direction only: recovery MAY safe-rewind to
   `pending` (instead of `needs_verification`) when intent exists but
   the breadcrumb log shows ZERO mutating continuations of any kind for
   the run. Any mutating continuation — including cross-origin and
   beacon-type — means P2's park rule stands; never rewind based on
   origin or resource-type filtering. Add this refinement to the
   recovery function with tests for both branches.
7. **Adversarial fixture.** Extend the P2 integration harness (local HTTP
   server as the "employer"): a page whose text contains an injection
   instruction to submit anyway plus an auto-POST and a form; under
   dry-run assert the server receives ZERO mutating requests, the blocked
   artifact exists, coverage classification is correct, and a synthetic
   `RESULT:APPLIED` maps to `dry_run_violation`. Add: a
   third-party-beacon page asserting coverage stays `full`; a step-POST
   page asserting `partial`; a cross-origin iframe form page (second
   local server port acting as the "ATS vendor") asserting its POST is
   blocked and demotes coverage; a redirect-then-POST page asserting the
   post-redirect submit is blocked; and a WebSocket page asserting
   construction is blocked and reported.

**Definition of Done**
- [ ] Zero non-GET/HEAD requests reach either harness server
      (page-origin localhost AND cross-origin/iframe/redirect paths)
      under dry-run, including sendBeacon and WebSocket traffic — no
      localhost carve-out exists.
- [ ] `dry_run_violation` replaces the coercion; no path can emit
      `applied` or `DryRunComplete` from a dry-run violation.
- [ ] Coverage classification fixtures pass (full / partial /
      third-party-beacon cases).
- [ ] Breadcrumb-refined recovery fixtures pass: rewind only on a
      zero-continuation log; any mutating continuation (any origin or
      resource type) parks as `needs_verification`.
- [ ] Event/state ripple complete: both registries, handlers, fixtures,
      badges; parity tests green.
- [ ] Full sweep (§0.3) passes.

### W1.3 — Agent sandbox hardening

**Objective:** the apply agent runs with an explicit tool allowlist, a
minimal environment, a per-run budget, and scoped Gmail access.

**Branch:** `feat/w1-3-agent-sandbox` ·
**PR title:** `feat(apply): explicit tool allowlist, minimal env, per-run budget, scoped Gmail`

Work items (all in
`workers/automation/src/jobhunter/infrastructure/apply/claude_code_cli.py`,
`workers/automation/src/jobhunter/domain/apply/services.py`
(`_default_mcp_config` ~:190–214), and
`workers/automation/src/jobhunter/infrastructure/gmail/mcp_server.py`
unless noted):
1. **Allowlist replaces bypass.** Drop
   `--permission-mode bypassPermissions` (~:151). Pass `--allowedTools`
   with the exact enumerated tool names: the Playwright MCP tools from the
   pinned `@playwright/mcp` version MINUS `browser_evaluate`,
   `browser_file_upload` (see item 7), and any code-execution/install
   tool, plus the owned tools from items 5 and 7
   (`get_verification_code`, `upload_artifact`). Later items append
   their owned tools (W1.5 `type_credential`, W1.6 `solve_captcha`). Keep
   `--disallowedTools` as a belt listing the built-ins: `Bash`, `Edit`,
   `Write`, `NotebookEdit`, `WebFetch`, `WebSearch`. Delete the current
   `_DISALLOWED_TOOLS` list of nonexistent Gmail write tools (~:47–56).
2. **Allowlist parity test.** A test enumerates the tools actually
   advertised by the configured MCP servers and asserts
   `allowlist == advertised − explicit_exclusions`, so a
   `@playwright/mcp` version bump that adds a tool fails loudly instead
   of silently granting or missing it. Pin the `@playwright/mcp` version
   in the MCP config (replace `@latest`) so the parity test is
   deterministic.
3. **Minimal env.** Replace `env = os.environ.copy()` (~:158) with an
   explicit allowlist dict: `PATH`, `HOME`, `LANG`/`LC_ALL`, `TMPDIR`,
   plus only what the Claude CLI needs for auth (it reads config under
   `HOME`). No API keys. Secrets needed by owned MCP servers are injected
   via that server's `env` block inside the generated
   `.mcp-apply-{worker_id}.json` — write that file with mode `0600` and
   delete it in a `finally` block.
4. **Per-run budget.** Pass `--max-budget-usd` (verified present in the
   installed CLI) from a new setting (default `5.00`), plumbed like the
   existing model setting; `doctor` warns when the installed CLI lacks
   the flag (probe `claude --help` output).
5. **Purpose-built verification tool replaces raw Gmail reads.** The
   apply agent no longer gets `search_emails`/`read_email` — raw
   subjects and bodies are an exfiltration payload under prompt
   injection (those tools remain available to the feedback scanner
   elsewhere, unchanged). When spawned for an apply run, the Gmail MCP
   server exposes ONE tool instead: `get_verification_code()`.
   Server-side it searches within a scope fixed at spawn (argv from
   `_default_mcp_config`: earliest-timestamp = run start;
   allowed-sender-domain set derived from the job's application URL and
   company domain), extracts only OTP codes and verification links from
   matching messages, and returns those extracted values. Raw
   subjects/bodies never enter model context. Out-of-scope: returns
   empty with an explanatory string.
6. **Automated exfiltration fixtures (tool layer).** (a) A fixture
   mailbox message carrying a decoy secret in its body: assert no
   exposed tool-call sequence can return the body or the secret —
   `get_verification_code` yields only the extracted code/link. (b)
   Out-of-scope sender/time queries return empty. (c) `upload_artifact`
   (item 7) refuses any kind outside the run's reviewed artifacts. Also
   update the prompt hard rule: email tooling returns verification
   codes only; never transcribe email-derived content into page fields.
   Keep a full-agent live-model probe (harness page instructing the
   agent to fetch and paste inbox content) as a manual-QA checklist
   entry in `docs/local-reliability-qa.md` — the tool-layer fixtures
   are the enforced guarantee; the live probe is defense-in-depth.
7. **Owned artifact upload replaces raw file upload.** The current
   prompt instructs uploading the résumé by absolute path (`prompt.py`
   ~:620) via the Playwright file-upload tool — under prompt injection
   that is an arbitrary-file exfiltration channel (any readable path
   could be attached to an attacker's form). Exclude
   `browser_file_upload` from the allowlist (item 1) and add an owned
   `upload_artifact(kind: "resume" | "cover_letter")` tool hosted on a
   NEW dedicated owned apply-tools MCP server
   (`workers/automation/src/jobhunter/infrastructure/apply_tools/mcp_server.py`,
   modeled on the Gmail server). This server is THE home for owned
   apply-run tools: W1.5 adds `type_credential` to it and W1.6 adds
   `solve_captcha` to it — later items extend this server, never create
   another. The server resolves the CURRENT run's reviewed artifact of
   that kind to a path
   itself — the model never supplies a path — locates the pending file
   chooser / file input through its own CDP connection
   (`DOM.setFileInputFiles`), and attaches it. Refuses when the run has
   no such artifact. Update the prompt's upload instruction to: click
   the upload control, then call `upload_artifact`.

**Definition of Done**
- [ ] Golden test on the exact argv: no `bypassPermissions`, allowlist
      present, budget flag present.
- [ ] Allowlist parity test green against pinned server versions; none
      of `browser_evaluate`, `browser_file_upload`, `search_emails`,
      `read_email` appears in the apply agent's allowlist.
- [ ] Env-allowlist test: subprocess env contains exactly the allowlisted
      keys.
- [ ] Tool-layer exfiltration fixtures green: decoy body secret
      unreachable through any exposed tool; out-of-scope queries empty;
      out-of-run-artifact upload refused.
- [ ] MCP config file is 0600 and removed after the run (test).
- [ ] Full sweep (§0.3) passes.

### W1.4 — Truthful screening and typed attestations

**Objective:** the agent never fabricates legal or screening answers.
Legal answers come from typed profile attestations; unknown required
answers fail the run with an actionable reason instead of a lie.

**Branch:** `feat/w1-4-attestations` ·
**PR title:** `feat(apply): typed application attestations replace fabricated screening defaults`

Work items:
1. **Delete the fabricated block** in
   `workers/automation/src/jobhunter/apply/prompt.py` (~:79–85: the
   hardcoded age/background/felony/previously-worked/how-heard defaults).
2. **Typed attestations.** Add `application_attestations` to the profile
   contract (Python profile loader + validation, TS profile schema in
   `packages/contracts`): `age_18_plus`, `background_check_consent`,
   `felony_conviction`, `previously_worked_at_employer` — each
   `true | false | null` (null = unknown) — plus an extensible
   string-keyed map for additional attestations. `how_heard` stays a
   plain preference field, not an attestation. Update
   `profile.example.json` with nulls and comments.
3. **Prompt rendering.** Render an attestation section ONLY from non-null
   values. Instruct: if a required screening question maps to an unknown
   attestation, do not guess — output
   `RESULT:FAILED:missing_profile_data:<field>`. Parse that reason in the
   adapter and surface it as an actionable blocker (which field to fill)
   in apply-review/jobs UI.
4. **Evidence-bounded skills.** Replace the "answer YES … don't sell
   short" instruction (~:182) with: answer yes only when the tool or its
   family appears in profile/résumé evidence; otherwise answer honestly
   with adjacent experience. Never fabricate.
5. **Warnings, not claim-blocks.** `doctor` and the apply-review surface
   warn when the attestation set is incomplete ("live applies may fail on
   screening questions") — do not block claims on it; the run-time
   failure path is the enforcement.
6. Flip the W0.3 attestation tripwire from warning to strict for this
   file once merged (see W0.3 item 8).

Tests: prompt builder with full/partial/empty attestations; adapter parses
the new failure reason; UI blocker fixture; `doctor` warning unit test.

**Definition of Done**
- [ ] No fabricated default remains in `prompt.py` (release_check strict
      tripwire green for this class).
- [ ] Unknown-required → `missing_profile_data` failure with the field
      name, visible in the UI fixture.
- [ ] Full sweep (§0.3) passes.

### W1.5 — Credential handling

**Objective:** the account password never enters model context, argv, or
any persisted artifact.

**Branch:** `feat/w1-5-credentials` ·
**PR title:** `feat(apply): out-of-band credential typing and global secret redaction`

Work items:
1. **Remove interpolation** of the profile password (and paired email
   sign-in/sign-up lines) from `prompt.py` (~:614–615).
2. **Owned secure-input tool.** Extend the W1.3 apply-tools MCP server
   (`workers/automation/src/jobhunter/infrastructure/apply_tools/mcp_server.py`)
   with `type_credential(kind: "email" | "password")` — do NOT create a
   second owned server. The tool receives NO secret from the model: the
   server loads the profile itself, opens its own CDP connection to the
   run's Chrome, and types via CDP `Input.insertText` — but ONLY after
   verifying, via its own CDP inspection (pages are untrusted; a hostile
   page can stage a decoy field to harvest the credential), that the
   focused element: is an `<input type="password">` (or email/text for
   `kind="email"`); is visible (non-zero box, within the viewport, no
   `display:none` / `visibility:hidden` / zero-opacity ancestor);
   belongs to the top frame or a visible frame whose registrable domain
   matches the top-level document's (no hidden or cross-origin iframes);
   and that the document has focus. Refuse with a distinct error string
   per failed check, and when the profile has no password. Prompt: click
   the field, then call the tool. Add the tool to the W1.3 allowlist.
3. **Global redaction.** A `redact(text)` helper seeded at profile/config
   load with all secret values (profile password, any configured API
   keys) applied at every persistence sink: worker log writer, timeline/
   event persistence, and the P2 evidence artifacts
   (`apply_agent_output` etc.). Integration test: run the harness with a
   fake profile containing a distinctive fake password; assert it appears
   in NO persisted output.
4. **Unique-password guidance.** Because this tool types the credential
   into third-party pages, W2.2's responsible-use docs must instruct
   operators to use a unique, dedicated password for job-site accounts
   (never a reused personal password). The content lands in W2.2; this
   item adds the cross-reference.

**Definition of Done**
- [ ] Password string absent from prompt text, argv, env, MCP config main
      body, logs, events, and artifacts (needle-based integration test).
- [ ] `type_credential` refusal fixtures green: non-credential field,
      hidden input, off-screen input, cross-origin iframe field.
- [ ] W0.3 password tripwire strict-green for `prompt.py`.
- [ ] Full sweep (§0.3) passes.

### W1.6 — CapSolver as an owned tool

**Objective:** CAPTCHA solving is preserved, but the ~200-line REST script
and the API key move out of the prompt into owned code.

**Branch:** `feat/w1-6-owned-captcha` ·
**PR title:** `feat(apply): move CapSolver solving into an owned MCP tool; key leaves model context`

Work items:
1. Add `solve_captcha(kind, sitekey, page_url)` to the W1.3 apply-tools
   MCP server; the solver implementation lives in
   `workers/automation/src/jobhunter/infrastructure/captcha/` (imported
   by the server — no separate server process). Port the
   createTask/poll flow and the token-injection JavaScript currently
   embedded in `_build_captcha_section`
   (`prompt.py` ~:217–424) into Python (`httpx` for REST — this is a REST
   integration, not an LLM client) + CDP `Runtime.evaluate` injection.
   Return `{solved, kind, elapsed_s, cost_usd?}`; record a usage event or
   artifact per solve with observable cost.
2. The key reaches ONLY the apply-tools server via its per-server `env`
   block in the generated MCP config (W1.3 item 3); it stays
   server-side. The tool is registered only when the key is configured;
   otherwise it is absent AND the W1.3 allowlist omits it.
3. Shrink the prompt's CAPTCHA section to: if a CAPTCHA blocks progress
   and `solve_captcha` is available, call it once with the visible
   sitekey; on failure or absence output `RESULT:CAPTCHA`. Delete the
   embedded REST/JS block. Keep `doctor`/wizard behavior (key optional,
   default off).
4. Add `solve_captcha` to the W1.3 allowlist and extend the parity test
   to cover BOTH configurations (key present: tool advertised and
   allowlisted; key absent: neither).

Tests: server unit tests with a mocked CapSolver API (success, failure,
timeout); needle test that the key env var name and value appear nowhere
in generated prompt text or the main env; prompt no longer contains the
REST flow (W0.3 tripwire strict-green).

**Definition of Done**
- [ ] Key absent from prompt/argv/model env (tests).
- [ ] Solve flow works against the mocked API; failures return the
      CAPTCHA manual state without looping.
- [ ] Prompt CAPTCHA section reduced to the bounded instruction.
- [ ] Full sweep (§0.3) passes.

### W1.7 — Email applications as a controlled owned send

**Objective:** email-only postings become a real, safe capability. Today
the prompt references a `send_email` tool that does not exist (the wired
Gmail server is read-only) — this item builds the capability properly:
the agent only detects; owned code composes, the human approves, owned
code sends.

**Branch:** `feat/w1-7-email-applications` ·
**PR title:** `feat(apply): controlled email-application flow with approval-bound recipient`

Work items:
1. **Detection outcome.** Replace the dead email-only instruction
   (`prompt.py` ~:607–609) with: on an email-only posting, output
   `RESULT:EMAIL_ONLY:<address>` and stop. Adapter parses and validates
   the address syntactically.
2. **Owned candidate.** The worker validates the address appears verbatim
   in the stored posting record (enrichment snapshot / description). If
   not present → park with reason `email_recipient_unverified` for manual
   handling (injection defense: run-time page text cannot introduce a new
   recipient; failure mode is manual, not send). If present → persist an
   `email_application_candidate`: recipient, subject and body rendered by
   an OWNED template (display name, job title, company — agent-supplied
   prose is NOT used), attachment = the reviewed résumé artifact id.
3. **Approval binding.** The candidate surfaces in apply-review as a
   full preview (to / subject / body / attachment name). Approval writes
   the recipient and artifact id into the decision row (extending the
   W1.1 bindings). No send without it.
4. **Owned send.** Gmail adapter gains a send method (Gmail API,
   `gmail.send` scope added to the OAuth flow; `doctor` reports scope
   status; document the re-consent step). The send executes in the worker
   (no agent involved): write `ApplySubmitIntended` (reuse P2 machinery)
   → call the API → record the result. Crash after intent →
   `needs_verification`, same as browser submits. Dry-run: the adapter
   hard-refuses to send and returns the preview as evidence.
5. **Ripple.** New event(s) (e.g. `EmailApplicationCandidateRecorded`) in
   both registries + handlers + fixtures; any new review-item state gets
   its badge; parity tests must pass.
6. **Docs.** README + `docs/user/data-and-safety.md`: the new scope, what
   is sent, and that recipients are bound at approval time.

Tests: recipient-not-in-posting parks (never sends); template ignores
agent prose; dry-run never calls the send API (mock assert); intent is
persisted before the send call (ordering test); missing scope → 
actionable error; UI preview fixture.

**Definition of Done**
- [ ] No send path is reachable by the agent process (grep: send only in
      the owned adapter; agent allowlist unchanged except detection).
- [ ] All six test classes above pass.
- [ ] Full sweep (§0.3) passes, including `pnpm qa:test`.

### W1.8 — Withdrawn: dry-run-by-default surface defaults

**Owner decision (2026-07-06):** this item is removed from the release plan.
Do not implement, verify, or gate on dry-run-by-default behavior. Bare
`jobhunter apply` remains a live/non-dry-run apply path unless the caller passes
`--dry-run`; RPC/workflow apply starts keep the same default unless the caller
passes `dryRun: true`.

The safety requirements that remain in force are W1.1-W1.7: approval binding,
dry-run violation outcomes, apply-agent sandboxing, truthful attestations,
credential handling, CAPTCHA fail-closed/owned-tool posture, and controlled
email-application handling.

---

## 4. Workstream W2 — Public surface, naming, governance (from `main`)

### W2.1 — PyPI distribution rename *(removed 2026-07-05)*

Removed from this program: naming and PyPI publishing are deferred to the
owner's pre-publication rename train — see §1 "Naming" and the §5
checklist. Until that train lands, `publish.yml` stays
`workflow_dispatch`-only and the W0.3 structural block stays in force. Do
not implement anything here; if another item's Definition of Done appears
to require this rename, STOP and report. (Section number retained so
cross-references stay stable.)

### W2.2 — Responsible-use documentation and warnings

**Objective:** every preserved capability is disclosed; the operator makes
informed choices.

Work items:
1. `README.md` gains a "Responsible use" section and
   `docs/user/data-and-safety.md` is extended to cover, explicitly: live
   submissions to real employers; email applications (`gmail.send`
   scope); automated credential typing and the recommendation to use a
   unique, dedicated password for job-site accounts (W1.5); CAPTCHA
   solving via a paid third-party service, disabled
   unless a key is configured, with ToS/legal risk resting on the
   operator; scraping-source ToS risk including LinkedIn/Indeed defaults;
   the local API's unauthenticated-on-loopback boundary (per W2.3);
   AI spend and the W2.4 ceilings; the list of sensitive local artifacts;
   and synthetic-data-only expectations for bug reports.
2. `doctor` prints notices when: LinkedIn/Indeed boards are active, a
   CapSolver key is configured, the approval gate is off, attestations
   are incomplete (W1.4). Also cover the hardcoded board fallbacks in
   `workers/automation/src/jobhunter/discovery/jobspy.py` (~:998, ~:1071)
   so the warning reflects the boards actually used, not just
   `DEFAULT_JOBSPY_BOARDS` (`config.py` ~:53). *(The `doctor`/`cli.py`
   edits require temporal P5 merged — and P4 rewrites `discovery/**`, so
   re-locate the board-default seams by symbol after P4 rather than
   trusting these line hints. Split into a follow-up PR if the docs are
   ready first.)*

**Definition of Done**
- [ ] Both docs updated; no capability left undisclosed.
- [ ] `doctor` warning unit tests green.

### W2.3 — CSRF: `Sec-Fetch-Site` gate *(requires PR #233 merged)*

**Objective:** close the null-Origin fail-open without breaking local
non-browser clients (curl, seeds, scripts).

Work items: in the global `onRequest` hook (`apps/api/src/server.ts`
~:253–272), for unsafe methods, after the existing Origin/Referer logic:
if the `sec-fetch-site` header is present and its value is not
`same-origin` or `none` → 403 `cross_site_request`. Requests with no
Origin, no Referer, and no `Sec-Fetch-Site` (non-browser clients) remain
allowed, and this boundary is documented in `SECURITY.md` (loopback bind +
Host check + Origin/Referer + Sec-Fetch-Site; local processes are trusted;
also document the `JOBHUNTER_API_ALLOW_REMOTE_BIND=1` escape hatch as
operator-owned risk).

Tests (`apps/api/test/server.test.ts`): matrix — cross-site browser
request (`sec-fetch-site: cross-site`) → 403; same-origin browser → 200;
headerless curl-style → allowed; existing Origin/Referer cases unchanged.

**Definition of Done**
- [ ] Test matrix green; `SECURITY.md` updated.
- [ ] Full sweep (§0.3) passes.

### W2.4 — Per-lane spend attribution and token ceilings *(explicitly deferred for v2.0.0 by owner decision 2026-07-10)*

> **Release disposition:** deferred in writing under §0.5.2. The work and
> Definition of Done below remain the future implementation contract. v2.0.0
> ships only the already-implemented global estimated daily USD ceiling; no
> per-lane token-control claim may be made.

**Objective:** extend — do not duplicate — the spend system temporal P5
ships. P5 delivers the base: the `llm_spend` day-aggregate table
(init_db ensure-block), usage recording hooked at the existing capture
points in BOTH the legacy `llm.py` client and the agent-SDK client seam,
a `dailyBudgetUsd` setting (default 25, 0 = unlimited) plumbed through
all layers, a `check_spend_budget` preflight activity at the top of
every spending workflow raising non-retryable `BudgetExceededError`, and
settings + health-surface UI. W2.4 adds what P5 lacks: per-lane
attribution, token-denominated ceilings (USD estimates are unreliable on
subscription-auth lanes), apply-lane capture, and doctor visibility.
**If you find yourself creating a second spend table or a second
preflight, STOP — extend P5's.**

Work items:
1. **Lane attribution.** Extend P5's recording seam so every recorded
   usage entry carries a lane (`apply`, `scoring`, `tailoring`,
   `employer_analysis`, `enrichment`, `profile`, …): either lane
   columns/rows on `llm_spend` or a companion per-lane table folded at
   the same write points — ONE mechanism, no double-counting (P5's own
   tests already forbid double-counting; keep them green).
2. **Apply-lane capture.** P5 hooks `llm.py` and the agent-SDK client;
   the apply lane spends through the `claude` CLI subprocess instead.
   Record its usage from the result-message stats parse in
   `claude_code_cli.py` into the same ledger, lane = `apply`. (W1.3's
   per-run `--max-budget-usd` and P5's daily USD ceiling both remain —
   this adds attribution, not another cap.)
3. **Per-lane token ceilings.** Per-lane daily token ceilings
   (settings/env), enforced INSIDE P5's existing `check_spend_budget`
   preflight (extend its input with the calling workflow's lane),
   raising the same `BudgetExceededError` taxonomy. The global
   `dailyBudgetUsd` behavior is unchanged.
4. Propose default per-lane token ceilings; STOP for owner confirmation
   (§0.5.2).
5. **Visibility.** `doctor` prints today's spend by lane; extend the
   health surface P5 added with the per-lane breakdown. Document in
   README + `docs/user/data-and-safety.md`.

**Definition of Done**
- [ ] Every recorded usage entry is lane-attributed; apply-lane entries
      appear from the adapter parse (tests with fakes).
- [ ] Per-lane token ceiling blocks via P5's preflight (test); global
      USD ceiling behavior unchanged (P5's tests still green).
- [ ] No second spend table or preflight exists (grep-provable).
- [ ] Owner-confirmed defaults in place.
- [ ] Full sweep (§0.3) passes.

### W2.5 — DCO enforcement

Work items: add a DCO check workflow (a maintained DCO action verifying
`Signed-off-by` on every PR commit); `CONTRIBUTING.md` gains a sign-off
section (`git commit -s`) and the PR template mentions it.

**Definition of Done**
- [ ] DCO workflow present and green on its own signed PR.
- [ ] `CONTRIBUTING.md` updated.

### W2.6 — Contributor AI-auth truthfulness *(requires temporal P5)*

**Objective:** onboarding stops claiming a single provider key suffices
when the Tier-2 scoring/materials ensemble actually requires the
Claude Code session + Codex login + Gemini chain.

Work items: `doctor` Tier-2 readiness reflects the real auth chain (check
each: Claude session, Codex login, Gemini/Antigravity key) with per-link
status; `docs/user/getting-started.md` and `docs/user/configuration.md`
describe the full chain and what degrades when a link is missing.

**Definition of Done**
- [ ] `doctor` output test covers all-present / one-missing cases.
- [ ] No doc claims single-key sufficiency for Tier 2.

---

## 5. Release gate — flipping public (owner executes; you prepare)

All boxes below must be checked before the first tag. They must also be checked
before the visibility flip except for the single hosted-CI sequencing exception
recorded above: that box closes immediately after the public flip and before
docs deployment, tagging, or publication. Assemble this checklist, with links,
as the final deliverable.

- [ ] W0.1–W0.6 merged and Release Privacy green on the exact public-release
      `main` SHA. The code is merged and the exact release tree is locally
      green, but private-repository jobs currently fail before running because
      of GitHub billing. The 2026-07-10 owner sequencing decision supersedes
      the former every-commit hosted criterion: this box closes only when the
      immediate post-public exact-SHA run actually executes and passes. A
      zero-step failure is never accepted as evidence.
- [x] Temporal P1b–P5 merged (PR #232 program complete).
- [x] **G1 (crawl politeness) met:** every discovery/enrichment fetch surface
      (#1–#10 in the crawl-politeness plan) routes through the politeness gateway
      — robots honored, per-host rate limit + per-run budget, one honest
      owner-configurable user-agent, blocked/rate-limited/budget-exhausted
      recorded as non-error outcomes; no spoofed browser UA remains on any
      product fetch path. Delivered by the R10 train (PRs #297 → #315); ADR in
      `docs/decisions.md` (2026-07-06); plan
      `docs/plans/implemented/2026-07-05-crawl-politeness-plan.md`. Check when the R10 train
      is merged to `main`.
- [x] W1.1–W1.7 merged, each with review gate `Gate: PASS` and QA gate
      `Gate: PASS` per repo process.
- [x] Rename train executed (owner-side, after all W-items): full
      `JobHunter` → `JobCtrl` rename; `workers/automation/pyproject.toml`
      distribution name `jobctrl` (re-check availability and configure the
      Trusted Publisher immediately before first publish; a pending publisher
      does not reserve the name); the historical `publish.yml` stays disabled
      while the new release-only `release-pypi.yml` runs only for
      a published non-prerelease GitHub Release with exact
      manifest/archive/tag version parity; W0.3 structural check updated/retired.
- [x] W2.2, W2.3, W2.5, and W2.6 merged; W2.4 explicitly deferred by the
      owner in writing on 2026-07-10 for v2.0.0.
- [x] W0.6 dispositions closed: every concern fixed, backlogged
      (sanitized), or owner-accepted.
- [ ] Owner has recorded, in the flip PR/issue: acceptance of historical
      blobs remaining reachable (git history kept), and the capability
      posture (live submit, CapSolver, email send, LinkedIn/Indeed) as
      deliberate, disclosed choices.
- [ ] Final manual QA (human): `jobctrl doctor` clean with expected
      warnings; seeded `/apply-review` smoke showing approval → dry-run
      evidence → gated submit controls; one harness dry-run showing the
      blocked-channel evidence. No real applications.
- [ ] Owner flips visibility and tags the first release.
