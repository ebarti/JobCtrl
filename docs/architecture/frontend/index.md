# Frontend Architecture

This is the frontend contract for the [Python transformation](../../plans/2026-11-06-python-transformation.md). During the transition, a feature is complete only after its actual route and end-to-end journey use the Python application; the presence of a target interface alone does not establish that status.

The React application uses TanStack Router, Query and Form, local browser ports, and one shell-owned event connection. The Python application is the authority for HTTP actions and durable state. The frontend composes features; it does not own a second business writer or forward calls through the retired TypeScript API or JSON-RPC path.

- [Contexts](contexts.md): ownership and optional-feature boundaries.
- [Patterns](patterns.md): queries, routing, forms and presentation.
- [State and ports](state-and-ports.md): cache safety and I/O boundaries.
- [Realtime](realtime.md): committed events and invalidation.
- [Integration](integration.md): public interfaces and page composition.
- [Testing](testing.md): target E2E and static verification.
- [Structure](structure.md) and [reference](reference.md): source layout and risks.

## State and ownership

Server state lives in tenant-first Query keys owned by the feature that reads it. URL state belongs in Router; ephemeral component state stays local; only multi-step state that must survive navigation belongs in a persistent client store. Features own reads, mutations, input validation and invalidations as well as their panels. The shell provides layout, navigation, browser adapters, the query client and a single event stream. Dashboard, Activity, Settings, Evidence Map and job workspaces assemble public feature interfaces rather than reading a central business-data kernel.

## Original workspace composition

The redesign source candidate has **Jobs**, **My profile** and **Settings** as
its primary rail. Root/brand navigation lands on Jobs. Jobs retains the comparison
grid and contextual job workspace plus independent Requirements, Applications,
Outcomes, Interview library, Contacts and Materials entries. My profile opens on
Experience with peer Skills, Education, Personal details and Resume sections,
then Learning and Search preferences. Settings composes Connections, Budgets,
Automation, Appearance and Data & diagnostics; supported credentials/model/browser
deep links reveal their connection panel.

Reduced primary navigation does not remove feature-owned records, public APIs or
independent resources. Existing operations/evidence routes remain deliberate
inspection tools. Job context and URL-backed comparison state survive focused
document work through explicit validated return state. No global Advanced mode,
alternate business hub or automatic work-on-navigation is introduced.

The [redesign capability ledger](../../plans/2026-11-11-original-app-redesign.md)
tracks actual acceptance. A source composition or passing build alone is not
evidence that every return, draft, responsive or accessible flow passed.

## Shared Production And Demo Coaching

Semantic determinations remain source-bound model decisions with persisted provenance and explicit failure states. Neither production nor demo may substitute word matching or a static semantic verdict. Demo features use their owned synthetic workspace and make unavailable capabilities explicit; they must not quietly send real profile data or external requests. See the [semantic decision](../../decisions.md#_2026-10-07-semantic-judgments-are-llm-determinations).
