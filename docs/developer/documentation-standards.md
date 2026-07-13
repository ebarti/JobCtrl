# Documentation Standards

JobCtrl documentation is one guide with explicit owners, not a collection of
competing explanations. Put each fact in its canonical page, link to it from
other journeys, and keep current behavior, future architecture, and delivery
history visibly separate.

**Read this if** you are adding, moving, or substantially changing a public
documentation page.

## One Concept, One Owner

The owning page carries the explanation and mutable detail. Other pages give
only enough context to orient the reader, then link to the owner.

| Concept | Canonical owner |
| --- | --- |
| Public product behavior, command surface, runtime requirements, generated artifacts, and top-level safety | Root [`README.md`](../../README.md) |
| End-user setup, tour, normal flows, configuration, data, and security | The matching page under [`docs/user/`](../user/getting-started.md) |
| Contributor entry and reading path | [Contributor Start](README.md) |
| Repository layout and source ownership | [Repository & Ownership Map](repository-and-ownership-map.md) |
| Documentation governance and style | This page |
| Runtime processes and their responsibilities | [Runtime & Processes](../architecture/runtime.md) |
| Shared domain types, REST DTOs, JSON-RPC, and API layering | [Contracts, Types & API Boundaries](../architecture/contracts-types-and-api-boundaries.md) |
| Canonical data, domain events, read projections, SSE invalidation, and telemetry separation | [Data, Events & Projections](../architecture/data-events-and-projections.md) |
| Physical SQLite/file/config authority | [Storage](../architecture/storage.md) |
| Browser-facing API route families and SSE overview | [Local TypeScript API](../local-ts-api.md) |
| Focused route behavior | The matching page under [`docs/api/`](../api/operations-and-events.md) |
| Exhaustive route fields, status codes, and precedence | [Complete API Contract](../api/complete-contract.md) |
| Workflow/activity execution, retries, concurrency, and stage operations | [`docs/architecture/pipeline/`](../architecture/pipeline/index.md) |
| OpenTelemetry and Langfuse export | [Observability](../architecture/observability.md) |
| Backend and frontend architectural rules | The numbered [backend](../architecture/domain-model/index.md) and [frontend](../architecture/frontend/index.md) references |
| Product and technical invariants | [Requirements](../requirements.md) |
| Accepted architectural choices | [Decisions](../decisions.md) |
| Public direction and detailed deferred work | [`ROADMAP.md`](../../ROADMAP.md) and [`docs/backlog.md`](../backlog.md), respectively |
| Active delivery work and implemented records | [`docs/plans/`](../plans/) |

This ownership rule does not forbid a short recap. It forbids maintaining two
full route tables, two schema catalogs, two lists of defaults, or two competing
descriptions of the same runtime boundary.

## Current, Future, And Historical Material

Use these categories deliberately:

- **Current implementation** uses present tense and is grounded in current code,
  tests, and supported runtime behavior.
- **Future architecture** appears under a heading such as
  `Future architecture (not implemented)` and links to the owning target or
  backlog. Never mix a proposed hosted adapter into a current component table
  or diagram.
- **Decisions** explain why an accepted choice was made. Amend a decision when
  the choice evolves; do not use an old rationale as a current behavior spec.
- **Active plans** at the top of `docs/plans/` describe accepted work that is
  not complete under its own definition of done.
- **Implemented plans** and incidents are records. Link them for provenance,
  not as the primary instructions for current behavior.

Public documentation describes public, tracked project surfaces. Do not add an
inventory of private or untracked planning material to a public index.

## When Behavior Changes

Update the existing owner rather than creating a parallel page:

| What changed | Update |
| --- | --- |
| User-facing behavior, CLI commands, runtime requirements, generated artifacts, or safety notes | Root `README.md` and the owning `docs/user/` page when detailed guidance changes |
| Install, run, verify, or frontend-development commands | `docs/local-development.md` |
| QA expectations, regression matrix, or manually verified product paths | `docs/local-reliability-qa.md` or its focused `docs/developer/qa/` owner |
| API route family, JSON-RPC dispatch behavior, or SSE contract | `docs/local-ts-api.md` and the owning `docs/api/` page; field-level changes also update `docs/api/complete-contract.md` |
| Runtime process ownership or local-first boundary | `docs/architecture/runtime.md` or `docs/architecture/index.md` |
| Shared contract/type boundary | `docs/architecture/contracts-types-and-api-boundaries.md` |
| Canonical data/event/projection flow | `docs/architecture/data-events-and-projections.md`; physical table/file ownership stays in `storage.md` |
| Pipeline workflow, activity, concurrency, persistence, or failure behavior | The owning `docs/architecture/pipeline/` page |
| Tailoring input/output contract, validation, provenance, or gates | `docs/architecture/tailoring.md` |
| OpenTelemetry or Langfuse span/export behavior | `docs/architecture/observability.md` |
| Frontend state, contexts, ports, realtime, or testing architecture | The owning `docs/architecture/frontend/` page |
| Package metadata, dependency, or root tool command | `package.json` or `workers/automation/pyproject.toml`, plus the owning guide if contributor behavior changed |
| Agent, PR, or repository workflow rule | `AGENTS.md` |

Internal refactors, test-only changes, bug fixes with no public behavior change,
and mechanical renames do not need documentation churn. When a meaningful-looking
change correctly needs no docs update, say why in the pull-request description.

## Audiences And Tiers

| Tier | Pages | Bar |
| --- | --- | --- |
| 1 — Everyone | Homepage and `docs/user/**` | No unexplained jargon. Every terminal command is followed by a plain sentence explaining what it does. Screenshots and diagrams carry the product tour; text supports them. |
| 2 — Contributors | `docs/developer/**`, `docs/local-*.md`, and section overview pages | Technical but self-contained: expand acronyms on first use, open with a plain-language summary, and link to Tier 3 for depth. |
| 3 — Deep dives | Remaining `docs/architecture/**`, `docs/requirements.md`, and `docs/decisions.md` | Precision over simplicity, while still opening with a summary and keeping structural references stable. |

The primary audience is technical. Plain language removes unnecessary jargon;
it does not dilute engineering precision.

## Page Template

Every published page opens with:

1. an H1 title that matches its sidebar label; a section `index.md` uses the
   section name rather than “Overview”;
2. a one-to-three sentence plain-language summary;
3. on Tier 2–3 pages where the audience is not obvious, a one-line
   `**Read this if**` that names the question the page answers.

For a structural topic, put the smallest useful diagram before long prose.
Put exhaustive tables, field catalogs, and lookup lists last or in their
dedicated reference owner.

## Reader-Journey Order

Pages, section reading paths, and the VitePress sidebar follow the order a new
reader asks questions:

> What is it? → How do I use or run it? → What does it do? → How does each part
> work? → Where does data live? → How do I operate it? → How is it designed? →
> Where is the exact reference?

When adding or moving a page, keep these surfaces aligned:

- `docs/README.md`, the canonical repository documentation index;
- the relevant section overview or contributor router;
- `docs/.vitepress/config.ts`, the site sidebar.

The site homepage remains `docs/index.md`. `docs/README.md` is rendered when
browsing the `docs/` directory on GitHub and is not the site homepage.

## Terminology

Use the canonical term everywhere. On Tier 1–2 pages, introduce acronyms and
runtime jargon once before using the short form.

| Canonical | Avoid | First use on Tier 1–2 pages |
| --- | --- | --- |
| the TypeScript API | TS API, product API | “the local TypeScript API (the process the web app talks to)” |
| the Python worker | automation worker | “the Python worker (a Temporal worker process that executes workflows)” |
| the web app | web UI, React app, frontend app | “frontend” remains correct for the architecture layer |
| Temporal | — | “Temporal (the workflow engine)” |
| the JSON-RPC bridge | — | the TypeScript-to-Python protocol; bare “JSON-RPC” is fine afterward |
| Server-Sent Events (SSE) | — | expand on first use per page, then use “SSE” |
| read model (noun), read-model (adjective) | — | “the read model”; “read-model projection” |
| Discover, Enrich, Score, Tailor, Cover, Apply | — | internal stage names; the product UI folds Enrich, Score, Tailor, and Cover into the user-facing Discover preparation stage |
| a dry run (noun), dry-run (adjective) | Dry-Run Apply as a standalone name | “rehearse with a dry run”; it is recommended, not an enforced prerequisite |
| approval gates; approve a submission | consent gates, sign-off | the recorded decision is `approve_submit` |
| a live submission | live apply as a noun | the real, non-dry-run application submit |
| the apply agent | apply bot, apply worker | the Claude apply-runtime subprocess that drives the browser; on-disk `apply-workers` remains a path name |

Use domain terms within their bounded context. Do not rename an aggregate,
event, state, or policy in prose merely to sound friendlier; explain it once
and keep the ubiquitous language intact.

## Diagrams

- Use semantic HTML/CSS for small user-facing priorities, comparisons, and
  steppers. Use Mermaid for technical flow, sequence, state, and schema
  diagrams. Do not force a four-step explanation into a graph.
- Give each diagram one question. Never mix source dependency, runtime traffic,
  data correctness, and user journey semantics in the same map.
- Put a visible one-sentence takeaway or edge legend next to every diagram.
  Every Mermaid block also carries `accTitle` and `accDescr`; a complex diagram
  needs a prose or table alternative.
- Use `flowchart LR` for compact pipelines/data flow, `flowchart TD` for layered
  stacks, `sequenceDiagram` for call flow, and `erDiagram` for schemas. A user
  flow stays at or below eight nodes and ten edges; a technical overview stays
  at or below twelve nodes and fifteen edges. Split larger explanations.
- Solid dependency arrows mean “the source is consumed by the target.” In
  runtime/data diagrams, solid arrows are the primary synchronous or
  authoritative path; dashed arrows are asynchronous, eventual, feedback,
  retry, or invalidation paths. Label every non-primary edge and state the local
  grammar visibly.
- Theme colors, typography, and spacing come from
  `docs/.vitepress/theme/mermaid-theme.ts` and `MermaidRenderer.vue`. Never add
  a page-level Mermaid init block or `%%init%%` directive.
- Structural flowcharts use the shared semantic classes from
  `architecture/index.md`: `ui`, `ts`, `py`, `infra`, `store`, and `ext`.
  Persistent stores use cylinder shapes; external services use stadium shapes.
- Do not put `;` in sequence-diagram message text. Mermaid treats it as a
  statement separator and can silently blank the diagram.
- Zoom is a separate native control. Do not apply a button role to the diagram
  container or hide the SVG's title and description from assistive technology.
- A diagram states only verified current facts unless its heading and caption
  explicitly label it as future architecture.

## Callouts

- `::: tip` is for guidance and shortcuts.
- `::: warning` is for safety boundaries, destructive actions, and spend.
- `::: info` is for context and history.
- Keep callouts sparse. A page made mostly of callouts has lost its hierarchy.

## Links, URLs, And Stable References

- Prefer a relative Markdown link to the owning documentation page.
- Do not copy an exhaustive route/schema/default table into an overview merely
  to avoid one click.
- Published URLs do not change casually. Improve a title or sidebar label
  before renaming a file.
- Keep §-numbered headings stable under `architecture/domain-model/**`
  (§1–§11) and `architecture/frontend/**` (§1–§15); source comments and agent
  guidance cite them.
- Historical records under `docs/plans/implemented/**` and `docs/incidents/**`
  retain their original record unless an explicit closeout consolidates or
  annotates them.

## Verification

Run the documentation gates after editing published pages:

```bash
corepack pnpm docs:build
corepack pnpm docs:check:runtime
git diff --check
```

`docs:build` includes VitePress's dead-link check and the emitted-href gate.
`docs:check:runtime` starts a fresh preview and checks hydration, asset loading,
current-page navigation state, screenshots, and Mermaid rendering in a browser.

::: warning Rebuilds invalidate running previews
The preview server snapshots the distribution file list at startup. Rebuilding
while a preview is running can leave it serving HTML whose hashed assets no
longer exist. Restart the preview after every rebuild, and do not rebuild under
a preview another contributor is using.
:::

## Review Checklist

- The page has one audience and one owning concept.
- Current behavior is verified and written in present tense.
- Future behavior is explicitly labeled and linked to its owner.
- Historical context supports the explanation but does not replace it.
- Mutable defaults, route fields, and schema catalogs appear only in their
  reference owner.
- New navigation links, headings, and diagrams follow the stable conventions.
- Sensitive local data, private planning inventories, and secrets are absent.
