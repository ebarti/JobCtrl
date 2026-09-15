# Maintainer Workflow

JobCtrl uses the installed [Devflow skills](https://github.com/ebarti/devflow/tree/fadc1b99eaf20eaaea1987e0d2c48eb30372c8c0)
for agent work. The agent uses host tools, Git, `gh` and project commands directly;
Devflow's Python helper records work, results and observed usage in SQLite.
The application and public CI do not require Devflow.

## Setup

Install the linked revision or a compatible newer version using
[Devflow's installation instructions](https://github.com/ebarti/devflow/blob/fadc1b99eaf20eaaea1987e0d2c48eb30372c8c0/README.md#install).
Supply its documented prerequisites and authenticated tools. Keep the source
clone at a stable location: installed skills are links into that clone, and
updating it updates the skills. Resolve conflicting skill paths explicitly.

## Work And Models

Load `devflow` and only the role needed for the request. A direct request
authorizes its stated scope; discussion alone creates no work or issues.
Reuse the same work record for follow-ups and inspect actual repository and
remote state when resuming.

Delegated implementation defaults to **Sol/high** (`gpt-5.6-sol`, effort `high`).
Use a configurable worker with a fresh task context. Give it one observable
outcome, owned files, relevant dependencies, and exact verification steps with
expected results. Explicit user or project choices override the default; other
roles retain their selected models. Small changes need no separate worker.

## Verification And Delivery

Select checks and required independent review through
[Reliability & QA](../local-reliability-qa.md). The project command catalog is
`.devflow/checks.toml`; run selected commands directly with owned report paths.
Keep the user's acceptance conditions through delegation and verify every
required product mode through its actual entry point. Report verified, failed
and unverified conditions with observed evidence, including simulated dependencies.
Passing tests or review cannot establish an unexercised product scenario.

Keep work records, usage and evidence outside the repository. Preserve existing
records when changing workflow versions; the installed helper's
[state reference](https://github.com/ebarti/devflow/blob/fadc1b99eaf20eaaea1987e0d2c48eb30372c8c0/skills/devflow/references/state.md)
describes recovery and optional history import. Record actual usage with its
source; unavailable token counts and costs remain unknown. Publication follows
the user's requested endpoint, and each remote action needs an actual readback.
