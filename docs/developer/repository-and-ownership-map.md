# Repository & Ownership Map

The accepted Python transformation is in progress. This map identifies the
target source owners; files in the shared checkout or route declarations alone
do not prove that a capability has passed the integrated journey gates. See
[Runtime](../architecture/runtime.md) and the
[workstream plan](../plans/2026-11-06-transformation-workstreams.md).

## Source Shape

| Surface | Responsibility |
| --- | --- |
| `workers/automation/src/jobctrl/app/` | Python composition, HTTP/security, SQLite/event infrastructure, model gateway, durable actions, worker and preparation orchestration. |
| `workers/automation/src/jobctrl/features/<owner>/` | Feature domain, application actions, public services, owned schema, persistence and HTTP adapters. |
| `workers/automation/src/jobctrl/cli.py` | CLI entry point to the same Python application actions and public local API. |
| `apps/web/` | React/Vite navigation, feature views, ports, adapters, client state and query invalidation. |
| `apps/extension/` | Browser capture and user-reviewed autofill/Discovery transport, without submission authority. |
| `launcher/`, `packaging/`, `scripts/` | Native launch, source/installed lifecycle, packaging and contributor entry points. |
| `docs/` | User journeys, architecture, API, safety, QA and historical records. |

Legacy source may remain in the shared checkout until final integration. It is
not a second target authority. At cutover the app has no Fastify business API,
TypeScript/Python JSON-RPC bridge or duplicate business writer.

## Feature Owners

| Owner | Source and authority |
| --- | --- |
| Profile | Facts, evidence, sources, confirmations, preferences, baseline and approved wording. |
| Jobs / Discovery / Companies | Job identity and manual capture; optional search/ingestion; independent optional company research. |
| Requirements / Fit / Resumes | Qualified meanings and occurrences; person qualification and wording coverage; complete approved document composition, review, acceptance and export. |
| Contacts / Outreach | Contact facts/research; separate reviewed communication lifecycle. |
| Applications | Screening answers, exact-payload approval, assisted execution, intents, outcomes and Gmail feedback. |
| Interviews / Learning / Digest | Interview preparation and notes; plans/milestones; summaries and acknowledgements. |
| Compensation / Offers | Neutral pay evidence/calculations; separate actual offer terms and decisions. |

Each feature owns its schema and I/O adapters and exposes public service
snapshots or actions. Composition injects those ports; consumers do not query
sibling-private tables. Dashboard, Activity and Evidence Map compose public
feature reads. See the [domain model](../architecture/domain-model/strategic.md).

## Start A Change At Its Owner

| Change | Start with |
| --- | --- |
| HTTP/security, settings, events, shared action execution | `app/` plus the affected feature adapter and [API](../api/complete-contract.md). |
| A domain rule or canonical write | The owning `features/<owner>/` package and its public ports. |
| Preparation recipes, checkpoints or cancellation | `app/preparation.py`, action runtime and [pipeline](../architecture/pipeline/index.md). |
| Model meaning, source binding or usage | The owning feature and `app/model.py`; see [semantic requirements](../requirements.md#semantic-determination-requirement). |
| UI interaction or invalidation | `apps/web/` feature context and [frontend architecture](../architecture/frontend/index.md). |
| Runtime, distribution or Profile transfer | Launcher/packaging and [runtime](../architecture/runtime.md); never test with real user data. |

The [reliability guide](../local-reliability-qa.md) and
[Python journey ledger](qa/python-journeys.md) own verification. The recurring
target suite drives the real application/API/database/worker/renderer with only
external provider boundaries controlled; source files, route registration and
static checks are not a substitute for an integrated result.

## Future Architecture (Not Implemented)

Hosted identity, tenant isolation, distributed storage and a hosted deployment
need separate product and security decisions. Port names do not establish that
such adapters or guarantees already exist.
