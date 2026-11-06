# 4. Frontend Patterns

## 4.1 Query-Key Convention

Every server-state key starts with `["tenant", tenantId]`, followed by its owner and a stable list/detail hierarchy. Include filter and identity inputs in the key. A feature owns the key factory, query function, input and output validation, and mutation effects. A returned DTO is a snapshot, never a mutable shared object. Preserve string identifiers used by routes and URLs.

## 4.2 Hook Conventions

Hooks use the shared HTTP port and TanStack Query; components render public hooks or panels. A failed refresh retains the previous accepted result and displays the failure. A write timeout, broken response, or ambiguous server failure must not be represented as a confirmed failure: read canonical state before a retry that could duplicate an effect. A response cannot overwrite a later confirmed publication.

## 4.3 Route Shapes (TanStack Router, file-based)

Routes validate and map URL search state, and delegate prefetch or required reads to feature-owned helpers. Loader dependencies expose only the transport methods and Query operations required for that read, never a raw capability to a view. Prefetch stays best effort; a required detail read propagates its error. Start independent reads concurrently and avoid per-row fetches where a bulk public read exists.

## 4.5 View Composition

Dashboard, Activity, Settings, Evidence Map and job workspaces combine public panels and queries. Each panel owns its loading, empty, failure and retry states. Optional contributions are explicitly selected by the shell and injected into a core workspace through public slots; removing a contribution must not change the core feature's imports or behavior.

## 4.6 Forms Convention (TanStack Form)

Use TanStack Form and Zod `safeParse`, with visible validation, conflict and save states. Preserve the source revision/version used to create a write and revalidate approvals against their source. A failed save must not erase a user's draft or last accepted artifact.

## 4.7 Component Primitives (shadcn/ui)

Use the owned `shared/ui` wrappers over Base UI, accessible labels and keyboard behavior. Feature code does not bypass these wrappers or reach browser capabilities directly. Styling, theme and density remain presentation concerns, not domain authority.

The shadcn Rhea/Base preset provides the acquisition pattern; the copied wrappers belong to JobCtrl. Shared Dialog, Sheet, Select, Menu, Tooltip and related primitives keep their focus, keyboard, portal and controlled-state contracts at that boundary. Use the semantic layout primitives (`RouteWorkspace`, `PageHead`, `DisclosureSection`, `InspectorLedger`, `Empty` and `ToolRow`) for route hierarchy, progressive detail and audit facts. Visible product icons use Tabler.

## 4.8 Styling and density

Tailwind utilities and the CSS-first theme bridge in `styles/globals.css` consume the semantic variables in `styles/tokens.css`. Dark mode uses the root `data-theme` selector. The app shell owns density: compact, regular and comfy row heights are 44, 52 and 60 pixels. A table-scoped saved view may override density without changing the global preference. Keep visual status paired with text, and preserve readable focus and narrow-screen navigation.

## 4.9 Cross-Cutting Client State (Zustand vs Context)

Use local state for transient interaction, URL state for shareable navigation and Query for server state. Persist only navigation-surviving multi-step state in Zustand. Do not use client state to imply that an external action completed.

UI preferences, saved table views and intentionally recoverable multi-step drafts have their own persisted records. A saved table view is a presentation template: applying it writes its filters and sort to the route, while reopening a link respects that URL instead of silently replaying a saved filter. Bulk selection remains transient. Profile import records retain their version and transaction boundaries; personal drafts are not placed in a URL.
