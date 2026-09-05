# Preserve behavior while removing duplicated state and execution

Status: accepted for implementation on 6 September 2026. Four PRs are planned;
none is implemented by this plan alone. The owner authorized implementation,
review, synthetic QA, commits, pushes, and creation of the ordered PR stack.
The new stack is to remain open for review; merging it is a separate action.

## Starting point and delivery order

Cleanup PRs [#862](https://github.com/ebarti/JobCtrl/pull/862) and
[#863](https://github.com/ebarti/JobCtrl/pull/863) are merged. The starting
`main` commit is `782d3d5ff3c4eac17c8ff1c9be91f89a420bdc07`; the canonical
checkout was fast-forwarded to that commit and verified clean. Implementation
uses the existing dedicated task worktree, never the main checkout. Preserve
all unrelated local changes and exclude them from commits.

| Phase | Branch | PR base | Change |
| --- | --- | --- | --- |
| 1 | `refactor/review-draft-authority` | `main` | One owner for saved review-draft reconciliation |
| 2 | `refactor/structured-profile-draft` | Phase 1 | Object-valued profile and style editing |
| 3 | `refactor/canonical-batch-tailor` | Phase 2 | Batch selection delegates to the existing per-job lifecycle |
| 4 | `refactor/evaluated-tailor-candidates` | Phase 3 | Carry candidate evaluation evidence through selection |

This order makes each change independently reviewable within the requested
linear stack. It does not introduce dependencies between frontend contexts or
between frontend and worker implementations. Phase 4 builds on Phase 3's
single lifecycle for acceptance and persistence.

Use `gh stack` non-interactively. Create each child only after its parent's
focused validation and independent gates pass. Verify its base against the
published parent head. Each PR must contain only that phase's code, necessary
regressions, owning documentation, and plan progress. Do not create an extra
PR solely for this plan. Use Conventional Commit titles and commit messages.

## Objective and protected behavior

Remove duplicated ownership and repeated transformations while preserving
the product's saved facts and accepted artifacts. Success is measured by
deleted mechanisms plus regression evidence, not by file splitting or a line
count alone.

The relevant facts have distinct owners:

| Fact | Owner and invariant |
| --- | --- |
| Saved profile | Profile aggregate; unedited and unknown fields survive an edit/save round trip |
| Saved review draft | Server draft identity and revision; the apply context publishes its reconciled query-cache representation |
| Unsaved editor value | Mounted editor/form session; a late acknowledgement cannot replace later local edits |
| Accepted material | Materials generation and artifact lineage; a failed replacement leaves the accepted generation reviewable |
| Candidate evidence | One concrete candidate value for one exact payload/text; evidence must change whenever its text changes |
| Execution ownership | Existing workflow/attempt and transaction fences; stale or canceled owners cannot publish |

Read [frontend state ownership](../architecture/frontend/state-and-ports.md),
the [tailoring contract](../architecture/tailoring.md),
[pipeline operations](../architecture/pipeline/operations.md), and the
[QA matrix](../local-reliability-qa.md) at their respective phase boundaries.
Follow root and web `AGENTS.md` instructions.

Excluded work: a generic gate/workflow framework, global candidate caching,
new services, schema migrations, wire-contract changes, automatic retry-policy
redesign, single-leg analysis promotion, a broad shared Plate lifecycle
extraction, unrelated persistence/SSE cleanup, and dependency upgrades.

## Phase 1: one saved-draft reconciliation owner

### Evidence and replacement

`ApplyReviewView` combines a cached draft with retained create/save/seed/render
mutation responses and merges replies separately. Those mutations already
write draft responses to the query cache, creating two reconciliation paths.

Move response publication into one pure apply-context reconciler used by all
draft mutations. The view reads the job-scoped cache and retains only local
pending/error/unsaved state and necessary render/comparison metadata. Delete
the view's multi-snapshot selector and thread merger.

Ordering must be explicit. Revision numbers are local to a draft: establish
`draftId` and `baseGeneration` identity before comparing revision, state and
time. Preserve the existing intended same-draft rendered-state precedence.
An older request must not restore a replaced draft; a new generation's first
revision must not be rejected behind a previous generation's higher revision.
Use the available request/generation identity to resolve this boundary rather
than inventing chronological ordering for opaque IDs.

Threads, replies and feedback signals evolve independently of the document
revision. Reconcile by their existing IDs and update/state information so a
late full snapshot cannot erase a newer reply or signal. Preserve unchanged
references where appropriate, without relying on structural sharing to guard
unsaved edits.

The review Plate editor currently resets from incoming saved-value identity.
Add the smallest acknowledged-save/document-identity guard required to keep
typed value B when the save response for A arrives. Preserve formatting as
well as text. Do not use this as a reason to extract the entire shared editor.

### Ownership

- `apps/web/src/contexts/apply/hooks/useApplyReviewMutations.ts` and its tests;
  a colocated pure draft reconciler and focused tests.
- `apps/web/src/views/apply-review/ApplyReviewView.tsx` and its existing tests.
- Only the relevant review-session reset/acknowledgement path in
  `apps/web/src/contexts/materials/components/ResumeAuditPins.tsx`.
- Existing artifact-comparison browser fixtures and frontend state/QA docs.
- Test-only isolated API entry point and guarded E2E mode, reusing the existing
  marked screenshot workspace/environment helpers. Ordinary E2E action stubs
  do not intercept API startup capability dispatch, so the isolated process
  injects synthetic provider/credential ports and denies other subprocesses
  before running the required browser proof.

### Acceptance evidence

1. Controlled reversed completion of create/save/seed/render never regresses
   the selected saved revision or resurrects an obsolete draft.
2. New-generation revision 1 can replace an older-generation revision 9;
   delayed responses for the old generation cannot reverse it.
3. Reply then stale full snapshot preserves replies, thread state and feedback
   signals; independent replies do not depend on document revision ordering.
4. Requests completing after a job/tenant switch update only their original
   cache key and do not change the new selection/comparison baseline.
5. Save A, type B, receive A: B and its dirty/save state survive. Unrelated
   thread updates preserve unsaved formatting, focus and editor selection.
6. Render-on-approval uses the selected saved revision. Accepted-artifact
   comparison, unmatched comments, reload restoration and failure states work.
   When promotion advances queue artifacts and creates a new revision-0 active
   draft, completed-render evidence retains its original accepted baseline and
   risk labels while the editor shows the new draft state. Unrelated artifact
   identities clear the comparison; late seed QA waits for a published thread.

Required browser path: extend and run
`apps/web/e2e/tests/artifact-comparison.spec.ts` with synthetic responses that
prove the relevant ordering/edit preservation, not only static rendering.

## Phase 2: keep editable profile values structured

### Evidence and replacement

The profile form currently stringifies API objects, parses them in the
structured editor, stringifies every edit, and parses again for validation and
Plate projection. A raw JSON editor is no longer a product requirement.

Keep editable `profile` and `style` as immutable object values in TanStack
Form. Keep actual template text as text. Serialize only when constructing the
existing string-valued update request. Use `safeParse` for validation while
preserving the edited original object; do not replace it with parsed/coerced
schema output that strips unknown data or erases incomplete typing states.

Adapt the existing semantic Plate projector to object input/output. Preserve
its source identity, conflict detection, target tracking and selective undo;
do not substitute whole-profile replacement or array-index matching.

### Ownership

- `apps/web/src/contexts/profile/forms/profile-form.tsx` and its tests.
- `apps/web/src/contexts/profile/components/StructuredProfileEditor.tsx`,
  focused tests, accessibility test and story.
- Relevant `ProfileEditor` integration tests; touch its production code only
  if required by the representation change.
- Existing `apps/web/e2e/tests/profile-edit.spec.ts` and owning frontend/QA docs.
- Narrow test-only API/launcher prevention: shared API fixtures explicitly
  fake/deny irrelevant dispatch, launcher tests copy the script into disposable
  roots with controlled shell environments, and Python payload setup uses
  isolated interpreter flags plus owned paths. Product runtime policy is unchanged.

### Acceptance evidence

1. The outgoing save request preserves unknown nested fields, unedited fields
   and the current request schema/field names. Profile and style serialize at
   the boundary. Existing server validation/normalization remains unchanged;
   this does not add storage for unsupported fields.
2. Incomplete numeric/date input remains editable; invalid chronological dates
   prevent save with the existing useful validation feedback.
3. An unrelated boxed edit plus a Plate edit both survive. Conflicting edits
   to the same field are surfaced and do not overwrite the boxed value.
4. Deletion, splitting, reordering and undo retain source-bound targeting;
   punctuation/digits and formatting-only changes preserve current semantics.
5. A stale autosave response or refreshed initial prop cannot erase newer
   local edits. Real SQLite save/reload retains supported synthetic values and
   ordering. The isolated preview seam generates escaped, semantically bound
   HTML from each current stored profile; no Python/PDF renderer is needed.
6. `/profile` and `/preferences` retain applicable controls, accessibility,
   dirty state and user-visible validation; no profile persistence behavior
   or discovery-setting behavior changes.

## Phase 3: delegate batch Tailor to the canonical lifecycle

### Evidence and replacement

Selected-job preparation already uses `tailor_job_by_id`, including its
ownership/cancellation fences, attempts, prerequisites and commit recovery.
Unscoped `run_tailoring` duplicates execution maps and stage writes and does
not receive the enclosing cooperative cancellation event through generation.

Retain the current bounded cohort selector, one captured profile/policy
snapshot and a bounded executor. Delegate each selected JobId to
`tailor_job_by_id` with existing model/judge/tenant/threshold/retailor options,
workflow identity and cancellation token. Delete the duplicate lifecycle's
start/attempt/terminal-write loop and maps. If sharing the existing selected
executor requires extraction, use one concrete application helper callable
from both routes; avoid a dependency from the runner back into activities.

Keep aggregation adapters explicit: the unscoped activity escalates aggregate
errors/failures/exhaustion for its existing retry contract; selected work can
return partial success and approved IDs. Preserve no-work keys, elapsed/count
fields, completed-owner filtering and callable signatures. Do not begin
sharing injected repositories across worker threads. Map `already_done`,
prerequisite skips and exhausted `inner_status` deliberately.

Stage-start events should reflect actual item dispatch rather than claiming
all selected jobs are running before workers start. Preserve any required
durable queued cohort and document this cancellation-correctness change.

### Ownership

- `workers/automation/src/jobctrl/scoring/tailor.py`.
- `workers/automation/src/jobctrl/pipeline/runner.py`.
- `workers/automation/src/jobctrl/materials/activities.py` and a narrowly
  extracted application executor only if needed.
- Existing Tailor, material activity/recovery, workflow and UoW test families;
  pipeline operations and QA documentation.

### Acceptance evidence

1. Exercise `tailor_activity` without `job_ids`, not only the per-job helper.
   Compare its resulting canonical state with the selected entry path.
2. With more jobs than workers, cancellation during a fake generation stops
   later dispatch; canceled/stale owners cannot write material or terminal
   success/failure. A successor owner's work remains intact.
3. Commit-before-cancel stays succeeded. Crash-after-commit retry reuses the
   accepted generation without another model call.
4. Prerequisite blocks do not increment attempts; the fifth durable failure
   remains exhausted; explicit reset and downstream blocking keep their rules.
5. Preserve tenant isolation, limits, saved thresholds, model/judge choices,
   retailor selection, mixed results and approved-only downstream Cover scope.
6. Preserve the last accepted artifact on cancellation, rejection, exception
   and rollback. Empty frozen cohorts do not invoke an unscoped fallback.

Before executing `scripts/reliability-demo.sh`, remove inherited database,
configuration and provider overrides, prohibit dotenv/Keychain/provider lookup,
inject a synthetic API dispatcher, assert owned paths before worker bootstrap,
and pass non-null expected application/database paths to the workflow. Retain
captured-PID shutdown. The existing harness must not run unchanged for this
stack; cover its required isolation with negative fixtures first.

Use the existing synthetic material/activity fixtures and relevant
preparation cancellation/recovery matrix. Audit the repository's four-process
reliability harness before using it; if required by the touched operational
path, run both documented restart orders using only its captured temporary
workspace and PIDs. Never substitute an existing user runtime for this proof.

## Phase 4: carry evidence with each evaluated candidate

### Evidence and replacement

The generation loop computes validation, provenance and fit, then selection
and voice/audit reconstruct evidence for unchanged text. Fabrication checks
also occur after paid review even when deterministic rejection is possible.

Extend the existing concrete `_TailorCandidate` in Materials to retain the
exact payload/text, validation, provenance, fabrication findings, grounding/
coverage, fit, verdict and audit information that belong to that candidate.
Build execution-invariant profile evidence/plan once. Selection returns the
evaluated value; unchanged selected text carries its evidence forward.

```text
payload -> deterministic evaluation -> eligible candidate -> paid review
                                      -> selected candidate + its evidence
                                         -> unchanged: reuse
                                         -> changed voice: evaluate anew
                                            -> rejection: retain accepted base
```

Move deterministic fabrication blockers before judge/adversarial calls while
preserving distinct validation, fit, semantic, rendering and fabrication
responsibilities. A voice rewrite is a new candidate and must pass its full
required evaluation. Do not reuse evidence for different text, weaken gates,
alter ranking/retry policy, or hide audit warnings to achieve fewer calls.

### Ownership

- `workers/automation/src/jobctrl/domain/materials/use_cases.py`, extending
  the existing value rather than adding a generic evaluation framework.
- `test_materials_use_cases.py`, `test_tailor_voice_audit_integration.py`,
  and relevant materials acceptance/provenance/UoW fixtures.
- Tailoring contract and QA documentation, including changed gate ordering.

### Acceptance evidence

1. Counting fakes establish one evaluation of unchanged base text/provenance,
   with no repeated evaluation at selection or no-op voice/audit boundaries.
2. A deterministically fabricated candidate makes zero paid judge/adversarial
   calls; typed repair guidance and bounded repair behavior remain coherent.
3. Changed voice text receives complete evaluation; rejection retains the
   accepted base text/evidence and labels the rejected attempt accurately.
4. Persisted provenance, fit/coverage and artifact bytes refer to the selected
   candidate; warning lifecycle and judge/audit details remain inspectable.
5. Candidate ranking, lenient/strict behavior, all-candidates-fail outcomes,
   prerequisite handling and safe retry guidance retain existing contracts.
6. Acceptance or rendering failure preserves the previous accepted generation
   and provenance atomically.

## Validation, isolation and delivery gates

All four phases are **Tier 3** because their changed executable paths touch
saved user edits, artifact approval/preservation or execution ownership. Each
phase requires focused tests plus an independent reviewer and QA `Gate: PASS`.
Use the same reviewer and QA agents throughout, and rerun failed gates after
fixes. Do not start the next phase with unresolved Blocker/High findings.

All executable validation must use synthetic/disposable data. Establish
`JOBCTRL_DIR` and relevant database/config/telemetry environment variables in
the child process environment **before any application import or bootstrap**.
Before opening a database or starting a product path, assert the resolved
paths are inside the owned disposable root. Fail closed if that check fails.
Use the repository's existing isolation fixtures and fake providers. Do not
read, copy or mutate a real user database, profile, settings, generated
material, browser profile, credentials or live Temporal/API state. Do not
start application submission, real discovery or paid model operations.

For process/browser QA, inspect fixture configuration first, use dedicated
ports and only terminate process trees captured by that fixture. Do not reuse
an existing server or default supervisor tracking directory. Preserve existing
dependency locks; use the provisioned Python environment with `--no-sync`
when necessary, and record that choice. No tests may rewrite unrelated work.

For phases 1 and 2, the command set is:

- `corepack pnpm web:check` and `corepack pnpm --filter @jobctrl/web test`
  (focused file selection during implementation; complete web suite for the
  final frontend phase).
- `corepack pnpm --filter @jobctrl/web test-d` and `corepack pnpm web:build`.
- Run the reviewed owned-environment browser runner with child command
  `corepack pnpm --filter @jobctrl/web exec playwright test --config=e2e/playwright.config.ts tests/artifact-comparison.spec.ts --project=chromium --retries=0 --output=<owned-results>`.
  Phase 2 uses
  `corepack pnpm --filter @jobctrl/web exec playwright test --config=e2e/playwright.config.ts tests/profile-edit.spec.ts --grep 'structured profile persistence' --project=chromium --retries=0 --output=<owned-results>`.
  The runner establishes the guarded environment and output path before any
  import; these fixtures prove the changed race/preservation behavior.
- Build Storybook and run the relevant browser/a11y coverage for touched
  mounted editors/stories. Existing critical/serious violations cannot be
  silently carried into the changed flow.

For phases 3 and 4, run Ruff over the touched Python source/tests and focused
pytest families listed above with the isolated environment already set. The
final Python phase runs the full Python suite. Include the existing workflow,
activity cancellation/recovery and materials transaction matrix that proves
the changed boundary, plus the exact unscoped activity and candidate-counting
product fixtures. Tests that only call a replacement helper do not prove the
removed entry path.

Every phase runs `git diff --check`. Owning docs for active high-risk behavior
change in that phase; do not defer cancellation or gate-order truth. Run
`corepack pnpm docs:build` for changed site content/links. On the final branch,
run the cumulative web and Python gates and the required synthetic product
scenarios; reuse already passing unaffected results rather than inventing
unrelated checks. Confirm all applicable GitHub checks pass on published heads.

The coordinator owns plan maintenance and gate dispatch. One implementation
agent, `gpt-6-astra` at `high` reasoning, owns the four sequential changes,
focused validation, commits and PR publication. It must not spawn replacement
reviewers or broaden the scope. A newly discovered prerequisite is included
only when necessary for these acceptance criteria; otherwise record it outside
this stack without implementing it.

## Completion record

Update this table with actual results; do not mark proposals implemented.

| Phase | PR and head | Deleted mechanism | Tests and product proof | Review / QA |
| --- | --- | --- | --- | --- |
| 1 | [#865](https://github.com/ebarti/JobCtrl/pull/865); `2428ce2ddd` | View-owned five-snapshot draft selector and reply merger removed; cache mutation publication reconciles saved state | Focused/type/build checks pass; corrected promotion regression passes 71 tests. All 4 isolated Chromium scenarios pass, scoped axe clean, 9 ownership/config tests pass | Reviewer and QA: PASS; High resolved; all applicable CI successful, merge state CLEAN |
| 2 | [#866](https://github.com/ebarti/JobCtrl/pull/866); implementation `1a54c7a6b` | Form/editor/projector JSON round trips removed; object drafts preserve original values and serialize at the request boundary | 61 focused tests; full web 323 files/2020 tests, 13 type tests, web/API checks and web/Storybook builds pass. Docs build and pure preview-fixture test pass. Full API suite deliberately run through the reviewed owned pre-import environment: 59 files/828 tests PASS. | Initial review PASS; fixture delta review and two browser reruns pending. Initial browser failures exposed wrong caret targeting and noncanonical heading markup; corrected fixtures assert target selection and use renderer classes without suppressing axe |
| 3 | Pending | Pending | Pending | Pending |
| 4 | Pending | Pending | Pending | Pending |

Delivery means four published PRs with the exact base chain above, necessary
docs, passing independent gates and applicable CI, no unresolved Blocker/High
findings, a clean canonical main checkout, and all pre-existing unrelated work
preserved. Report any remaining Medium/Low observation with its concrete
impact. If required validation cannot run, leave that phase explicitly
unverified rather than calling the stack complete. Keep this plan active while
the delivered PRs remain unmerged; archive it after the implementation lands.
