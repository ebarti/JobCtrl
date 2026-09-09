# Maintainer Workflow

JobCtrl consumes devflow through `.devflow/repository.toml`, named commands in
`.devflow/checks.toml`, and the immutable revision in `.devflow/workflow.lock`.
The package owns workflow state and recovery. JobCtrl owns its product contracts,
risk selection and actual verification commands. This is contributor tooling;
the application and public CI do not depend on the private maintainer package.

## Installed Entry

An enrolled maintainer host installs the reviewed release under
`~/.local/share/devflow/releases/<revision>` using devflow's managed installer.
The private installation manifest records the active skill link, exact target
paths and shared consumers before changing anything. Other repositories' review
skills, Claude adapters and model settings remain their existing owners.

Run from a JobCtrl checkout:

```sh
scripts/devflow doctor --json
scripts/devflow profile inspect --json
scripts/devflow backlog list --json
scripts/devflow work list --json
```

The launcher resolves this checkout's pin and runs the installed release with
an isolated Python environment. It does not fetch the private package or upgrade
the lock. `DEVFLOW_INSTALL_ROOT` can select another managed installation root;
`DEVFLOW_STATE_DIR` selects private durable state. Keep state, journals, evidence
and installation manifests outside the repository. A missing release blocks
enrolled automation with a diagnostic. Public contributors use
[Contributing](../../CONTRIBUTING.md) and the same
[QA requirements](../local-reliability-qa.md) through ordinary local commands.

## Everyday Work And Recovery

Load the installed skill and only the current role reference; use `scripts/devflow`
for its `devflow` commands. Capture each
substantive request with `scripts/devflow backlog capture --request-file <json>
--json`, reusing its existing issue or a stable work ID with a short public-safe
outcome, acceptance and context. Follow-ups stay on that issue. Public issue
content does not grant execution authority. A Project is optional: an active
linked PR can show progress without Project permissions.

After interruption, list saved backlog/work IDs and use `backlog capture
--work-id <id>` or `work show --work-id <id>` followed by `next --work-id <id>`.
Uncertain external writes require reconciliation; never invent a replacement ID
to force another issue, task, comment or PR. Active attempts retain their captured
workflow revision even after a repository upgrade. Preserve prior releases and
state during a managed-link rollback.

Choose recipes through the [QA router](../local-reliability-qa.md). Add a focused
recipe before work admission when the relevant test file or scenario is missing;
recipe definitions do not require running all suites. Required JUnit recipes
reject zero executed test cases, failures and skipped cases. Case counts do not
measure individual assertion calls; independent QA must still prove meaningful
behavior. The `diff` recipe compares committed changes with `origin/main`; a PR
with a different base needs a matching focused recipe before admission. An unavailable browser or
native task cannot stand in for passing product proof.

## Activation Boundaries

The installed CLI/profile and durable issue intake can run independently of
native task dispatch. Visible owner/review/QA tasks use the native host bridge
only with an explicit user launch instruction. Hosts without that capability
cannot claim a devflow role gate; existing bootstrap review evidence must remain
identified as bootstrap evidence. This adoption does not rewrite global role
models or silently migrate existing work attempts.

Automatic merge remains disabled until separately authorized target protection
passes live conformance, including strict freshness, the required
`devflow/verified` check and no acting-account bypass. This profile does not
change GitHub protection, enable a scheduler, create a Project, or grant merge
or release authority. Current work may be delivered to a regular PR for review.

See the [cutover accounting](workflow-cutover.md) for removed process owners,
retained product checks and the historical backlog dispositions.
