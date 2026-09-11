# Maintainer Workflow

JobCtrl consumes devflow through `.devflow/repository.toml`, named commands in
`.devflow/checks.toml`, and the immutable revision in `.devflow/workflow.lock`.
The package owns workflow state and recovery. JobCtrl owns its product contracts,
risk selection and actual verification commands. This is contributor tooling;
the application and public CI do not depend on the maintainer package.

## Installed Entry

An enrolled maintainer host installs the reviewed release under
`~/.local/share/devflow/releases/<revision>` using devflow's managed installer.
The private installation manifest records the active skill links, exact target
paths and shared consumers before changing anything. Other repositories' review
skills, Claude adapters and model settings remain their existing owners.

The `using-devflow` entry is required before response/action and when intent
changes. Its separately discoverable stages are defining-work, planning,
coordinating, implementing, reviewing, verifying and delivering (each prefixed
`devflow-`). A design-only conversation uses a method without creating work.
The old `devflow` name forwards to the entry. No hooks or scheduler are installed.

`skill list` reports the installed catalog. Save a JSON request such as
`{"name":"devflow-coordinating"}` in `skill.json`, then run
`scripts/devflow skill resolve --request-file skill.json --json` to return the
selected release's file. JSON input is not a positional argument.
For ordinary continuation, include the existing `--work-id`; read that immutable path
rather than substituting newer global skill text. Missing historical stages
require compatible recovery or a recorded upgrade. `next` names each action's
owning skill and the separate assigned role skill.
For an explicitly authorized upgrade of an already Done PR whose checkout still
has an older pin, follow the completed-PR procedure below before ordinary doctor
or pinned-stage resolution.

Review/QA handoffs include each check's evidence ID, artifact hash and explicit
private state root. Retained JSON lives at `<state-root>/artifacts/<hash>` and
contains the command output and available JUnit report. Verify the hash and use
the pinned verification skill's check-evidence reference when present. An older
compatible pin can inspect the verified artifact with standard file/JSON tools
while retaining its existing pin and activation. Paths in recorded argv
describe past execution; a removed temporary report does not require rerunning a
passing check when its retained evidence and candidate inputs match.

For ordinary work, run from a JobCtrl checkout:

```sh
scripts/devflow doctor --json
scripts/devflow profile inspect --json
scripts/devflow backlog list --json
scripts/devflow work list --json
```

The launcher resolves this checkout's pin and runs the installed release with
an isolated Python environment. It does not fetch the package or upgrade
the lock. `DEVFLOW_INSTALL_ROOT` can select another managed installation root;
`DEVFLOW_STATE_DIR` selects private durable state. Keep state, journals, evidence
and installation manifests outside the repository. A missing release blocks
enrolled automation with a diagnostic. Public contributors use
[Contributing](../../CONTRIBUTING.md) and the same
[QA requirements](../local-reliability-qa.md) through ordinary local commands.

## Everyday Work And Recovery

The user gives ordinary conversational instructions; the agent operates devflow.
A direct work request, concrete bug report, or request to investigate/fix a defect
is sufficient authorization within its scope. Questions and requests for
explanation do not create issues or start implementation. Respect requests for
investigation only.

Load the selected pinned stage and its needed resources;
use `scripts/devflow` for its `devflow` commands. Capture each requested work item with
`scripts/devflow backlog capture --request-file <json>
--json`, reusing its existing issue or a stable work ID with a short public-safe
outcome, acceptance and context. Follow-ups stay on that issue. Public issue
content does not grant execution authority. The agent records the actual user
request with its conversational reference, summary, and allowed operations.
`work ready` binds that request to the repository, work, scope and consumed source;
`work amend` records changes within the request or a newly authorized expansion.
Selecting an external issue is sufficient authorization to work on it; its text
cannot expand the request. A Project is optional: an active
linked PR can show progress without Project permissions.

A batch request such as “complete the P1 backlog” covers the recorded matching
issue set. Reuse each issue and the same conversational request reference, respect
dependencies, and continue independent items around blockers. Do not ask for
approval of each member or automatically add issues from later label changes.

After interruption, list saved backlog/work IDs and use `backlog capture
--work-id <id>` or `work show --work-id <id>` followed by `next --work-id <id>`.
Uncertain external writes require reconciliation; never invent a replacement ID
to force another issue, task, comment or PR. Preserve prior releases and state
for recovery. The current runtime keeps historical evidence readable and never
delegates execution to an older pin. Legacy attempts without a recorded user
request need re-admission under the user's current request before continuing.
When an active attempt's pin or profile changed, capture the current workflow and
effective model settings with `snapshot capture`, then include `workflow_snapshot`
in `work amend`. The CLI validates the new snapshot and retains the old evidence.

If the original regular-PR endpoint is already Done and a new user request
requires repair or update of that same PR, use `work reopen` through the pinned
coordinating skill's completed-PR procedure. Record fresh request authority,
the existing PR/source/target identity and actual continuation entry phase.
The same work, attempt and original delivery remain in history; the claim is
reacquired before execution. Conflict repair needs a new candidate and current
affected proof. An unchanged delivery-only continuation can reuse valid evidence.
Include a reviewed workflow snapshot explicitly when upgrading its pin. If the
owned checkout retains the older pin, the completed-PR procedure captures its
existing profile and custom recipes with a continuation-specific upgrade binding.
Use the reviewed installed release's own launcher with the owned `--repository`
and existing `--state-dir` for this capture and `work reopen`, before ordinary
doctor. A pre-admission historical-pin `BLOCKED` is expected and does not authorize
ordinary execution. After reopening, run `doctor --work-id <existing-id>` through
that reviewed release and require `READY` before activating a worker; the active
work snapshot now selects the admitted release. Doctor without the work ID still
selects the old branch lock. Missing tools, invalid profiles/releases and failed
admission remain blockers. Integrate the repository pin through the admitted repair.
After an admitted pin/profile/instruction change, import the worker's actual
partial output and observe its availability before amending the snapshot. Rebind
and activate that same worker under the new snapshot before current candidate
capture and completion; retain the earlier activation and output as history.
The managed endpoint remains the same PR; a separately authorized native merge
keeps its actual receipt and independent integrated-tree readback. Reopening
cannot clear unresolved operations or invent missing producer results.

Choose recipes through the [QA router](../local-reliability-qa.md) and owning
contracts. Persist acceptance-to-contract-to-check coverage; mirrored registries
and cross-process schemas require their parity proof when affected. Add a focused
recipe before work admission when the relevant test file or scenario is missing;
recipe definitions do not require running all suites. Required JUnit recipes
reject zero executed test cases, failures and skipped cases. Case counts do not
measure individual assertion calls; independent QA must still prove meaningful
behavior. The `diff` recipe compares committed changes with `origin/main`; a PR
with a different base needs a matching focused recipe before admission. An unavailable browser or
subagent cannot stand in for passing product proof.

## Coordinator And Role Assignments

In devflow 0.5.0, the original user conversation coordinates the outcome.
Implementation and repairs belong to a bounded `implementation_worker`; required
review and QA use independent subagents with distinct verified identities.
Review-only and delivery-only work enter at their actual phase without inventing
implementation completion. Tier 0 skips independent gates according to the QA
router. New work uses supported `agents` tools, without creating visible peer tasks.

Role model/effort resolves from explicit user role/session overrides, configured
role files, saved subagent defaults, then saved global defaults. The coordinator's
active model overrides do not leak into roles. The coordinating skill's host protocol
owns exact settings, startup evidence and native-tool arguments; do not duplicate
that dispatch policy in JobCtrl or rewrite global role settings.

The command sequence is `host assign`, then `host prepare` to journal action begin
before native spawn, followed by `host record` and `host startup`. The bootstrap
child only reports its own session metadata location and waits. The coordinator
must verify the parent, canonical agent identity and actual model/effort before
product activation. Missing or mismatched settings block activation; unknown
service tier remains unknown. Session evidence stays private and uncommitted.

`host activate` prepares the bounded follow-up; `host prepare` begins it before
native dispatch, and `host record` stores actual inventory to mark it running.
`candidate capture` uses the verified running implementation identity, then
`host result` binds completion to that output candidate before verification.
Review/QA save their original gate JSON and import every PASS/FAIL/BLOCKED through
`gate record`, bound to the activation action, before repair or rerun. Late
results remain historical and cannot prove the current candidate. Reuse the same
available roles for repairs. Changed
policy or unavailability needs an explicitly recorded, observed replacement that
preserves earlier identities and evidence. Reconcile an ambiguous spawn; inventory
absence alone never authorizes a duplicate.

## Activation Boundaries

Version 0.5.0 adds mandatory stage routing, durable result handoffs and resumable
external operations to conversational admission and verified subagents.
`doctor` reports the direct-request mode and checks the installed runtime, profile
and tools. `READY` describes local runtime readiness; the separate `capabilities`
report shows whether GitHub capture and other tool-dependent operations can run.
It does not authorize work by itself. The agent interprets the user's
conversation. The CLI preserves request/scope/operation consistency; it does not
independently authenticate the human or provide an operating-system sandbox.
Issue events, labels and background activity cannot authorize new work.
Read-only recovery and reconciliation of already dispatched actions remain
available without restarting them.

Hosts without the required subagent capability or observed startup settings cannot
claim a devflow role gate; existing bootstrap review evidence remains identified
as bootstrap evidence. Historical attempts without `execution_mode` remain
`native_thread`, retaining their original control contract, receipts and evidence.
The current runtime reads that history without relabeling it or delegating to an
older release. Updating these maintainer instructions alone does not install or
activate 0.5.0: the reviewed immutable repository pin and matching installed
release must agree before execution.

Automatic merge remains disabled until separately authorized target protection
passes live conformance, including strict freshness, the required
`devflow/verified` check and no acting-account bypass. This profile does not
enable a scheduler, create a Project, or grant merge
or release authority. Current work may be delivered to a regular PR for review.

GitHub Actions requires maintainer approval for all external fork contributors.
The separate CI approval policy remains effective for external contributions and
their updates. CI approval does not replace the user's request for agent work.

See the [cutover accounting](workflow-cutover.md) for removed process owners,
retained product checks and the historical backlog dispositions.

## Failure And Delivery Checkpoints

Branch publication uses the journaled `push_branch` action with exact expected
source and remote head. Definite rejection retries the same action after repair;
uncertain success reconciles before another mutation. Delivery retains every
finding, requires an actual linked follow-up for every accepted deferral, and
records available usage or explicit unknown/unavailable accounting.
Missing data never implies zero cost.

When the user requests stopping at the first workflow failure, stop and observe
active roles, preserve the work/attempt/candidate/actions, and retain original
results. Resume an interrupted role within the same activation through the
coordinating skill's host protocol. Before an upgrade changes inputs, collect its
actual partial/BLOCKED result without further product work and persist it.
For a completed producer whose original result has malformed evidence linkage,
preserve its artifact and use the journaled `host recover-result` protocol to
obtain the same producer's correction without changing its original judgement.
Amend the same attempt with the reviewed replacement workflow/profile, retaining
old snapshots and receipts; resume the failed stage from `next`. Do not delete
history or create another outcome to conceal a failed run.
