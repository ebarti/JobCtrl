# Architecture

JobCtrl's transformed source application is a Python modular application with
SQLite, a React frontend and Temporal durable execution. It keeps one application
authority and independently removable feature owners. This source architecture
does not imply that a new installed release has been published.

| Boundary | Owner |
| --- | --- |
| HTTP, CLI and worker composition | `workers/automation/src/jobctrl/app/` and explicit runtime entrypoints. |
| Canonical feature state and actions | `workers/automation/src/jobctrl/features/<owner>/`. |
| Browser presentation and data access | Feature-owned React panels/queries/actions with a small shared shell. |
| Durable orchestration | Temporal runs the same Python application actions and explicit preparation recipes. |
| Process/installed lifecycle | Native launcher, supervised Temporal, runtime selection and deliberate Profile transfer. |
| External provider execution | Source-bound model gateway, isolated SDK adapters and explicit credentials. |

Profile owns facts, sources, confirmations and approved words. Jobs owns posting
identity and snapshots. Requirements owns qualified meanings and occurrences.
Fit owns person qualification and approved-wording coverage. Resumes composes the
complete approved baseline, records document coverage, renders and accepts
artifacts. Missing wording cannot lower factual qualification.

Optional Discovery, Companies, Contacts, Outreach, Applications, Interviews,
Learning, Digest, Compensation and Offers have separate owners. The neutral
Compensation core accepts caller facts and ports without depending on the
JobCtrl runtime. Core consumers use public snapshots; no sibling-private-table
reads or alternate business writers are permitted.

Start with [runtime](runtime.md), [storage](storage.md), and
[contracts and API boundaries](contracts-types-and-api-boundaries.md). The
[accepted transformation plan](../plans/2026-11-06-python-transformation.md)
records scope and evidence obligations. [Local API](../local-ts-api.md) documents
the current transport despite its retained documentation URL.
