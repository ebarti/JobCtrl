# Hexagonal Boundaries: Ports and Adapters

The target uses small, feature-owned ports at real I/O boundaries, not a generic
plugin framework or universal business repository. The implementation and
integrated contract are still in progress.

| Dependency | Public boundary |
| --- | --- |
| Profile → consumers | Immutable fact, source, baseline and approved-wording snapshots; authoring accepts a brief without importing Fit internals. |
| Jobs → consumers | Immutable job identity and posting/source snapshots. |
| Requirements → Fit/Resumes | Qualified requirement IDs, revisions and recorded occurrence/equivalence decisions. |
| Fit → Resumes | Person-fit results and approved-wording coverage relations as separate, revision-bound snapshots. |
| Resumes → Applications | Exact accepted artifact identity and source/approval state. |
| Contacts → Outreach | Contact facts and provenance through a public service. |
| Compensation → Offers | Neutral calculations and caller-supplied facts; no JobCtrl database, IDs, HTTP or workflow dependency in the core. |

Feature adapters own HTTP serialization, persistence and provider integration.
A consumer calls a sibling's public service and cannot query sibling-private
SQL. Snapshot values are immutable or detached copies; source and revision
fences are checked before publication. Missing required services fail startup
rather than falling back to legacy business handlers.

The foundation [integration contract](../../plans/2026-11-06-python-contracts.md)
defines the provisional `Feature`, `Runtime`, action and model interfaces.
The explicit composition root selects features and injects these public
services. Feature removal must be exercised through the real composed app.
