# Stack Research

**Domain:** Local-first job-application audit UX
**Researched:** 2026-06-11
**Confidence:** HIGH for current repo stack, MEDIUM for exact resume-pin rendering mechanics

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| React | 19.2.x in `apps/web` | UI composition for Jobs drawer and Apply Review | Existing production stack; supports componentized audit panes without changing routing or state architecture. |
| Vite | 7.x in `apps/web` | Web build and dev server | Existing fast local workflow; no new bundler needed for milestone UI work. |
| TypeScript | 6.0.3 root dev dependency | Contracts, API, and web type safety | Shared `@jobhunter/contracts` DTOs can make readiness/blocker drift a compile-time problem. |
| Tailwind CSS | 4.x in `apps/web` | CSS-first semantic token styling | v1.1 already migrated to shadcn semantic tokens; v1.2 should build on the current token system rather than add a second styling layer. |
| TanStack Router/Query/Table/Form | Current repo packages | URL state, server state, tables, forms | Existing frontend target architecture requires Operations hooks for reads and context-owned mutations for writes. |
| SQLite projection read model | Current API architecture | Local-first read DTOs for Jobs and Apply Review | The shared readiness/audit contract belongs in projection-backed API read models rather than duplicated UI derivation. |

### Supporting Libraries

| Library | Purpose | When to Use |
|---------|---------|-------------|
| `@jobhunter/contracts` | Shared DTO interfaces and schemas | Add the readiness/blocker contract and any resume-pin DTOs here before consuming them in web or API code. |
| `@tabler/icons-react` | Current icon target | Use for any new icon buttons, pins, warnings, and drawer controls. Do not add lucide usage. |
| Radix/shadcn copied primitives | Dialog/sheet/card/button/select primitives | Use existing shared primitives and sheet/drawer patterns rather than adding a new modal library. |
| `PdfPreviewViewer` | Existing PDF preview surface | Keep PDF rendering in the current viewer; add pin affordances around/alongside it only if anchors are stable. |
| Vitest + Testing Library + MSW | Unit/component/API hook tests | Cover shared contract mapping, readiness/blocker states, and component interaction states. |
| Playwright | Browser QA and E2E | Required for product-path proof across `/jobs` drawer and `/apply-review`; use synthetic or seeded data only. |
| Storybook + axe addon | Visual/a11y states | Use for new audit cards, pin inspector states, and drawer panel variants if components are extracted. |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| `pnpm web:check` | Web TypeScript check | Required when contracts or UI components change. |
| `pnpm web:build` | Production web build | Required before claiming user-facing route work is complete. |
| `pnpm --filter @jobhunter/web test` | Web unit/component tests | Add targeted tests for new view/context components. |
| `pnpm --filter @jobhunter/web e2e` | Browser E2E | Use targeted specs or documented Browser QA for the selected paths. |
| `pnpm api:test` | API/read-model tests | Required when shared readiness/blocker contract is computed by the API. |
| `rg` audits | Dependency/config/source checks | Use for folded cleanup: legacy tokens, stale Tailwind config references, lucide imports, and sensitive fixture text. |

## Installation

No new runtime stack is recommended for the milestone. The preferred implementation uses existing dependencies and components.

If a later plan proves that PDF coordinate annotations are required, evaluate that in a spike before adding a PDF annotation or text-extraction package. The MVP should first try stable generated-text anchors from `bulletProvenance` and `annotatedChanges`.

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Shared DTO in `@jobhunter/contracts` | UI-only helpers in Jobs/Apply Review | Only for transient labels that do not affect readiness/blocker facts. |
| Existing `PdfPreviewViewer` plus side rail/pin inspector | New PDF annotation library | Only if generated material text cannot be mapped to stable visible rows and a spike proves the library is worth the blast radius. |
| Operations read hooks | Direct `apiClient` calls in views | Never for this milestone; repo frontend architecture forbids direct API calls from views. |
| Existing shadcn/Radix primitives | New design system package | Not needed; v1.1 just established the visual foundation. |
| Tabler icons | Lucide icons | Avoid; v1.1 made Tabler the icon target and lucide cleanup is folded into v1.2. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| Separate readiness logic in each UI surface | This already caused visible disagreement risk between queue tags and API material fields. | A shared API/contract object consumed by both surfaces. |
| PDF-only pin coordinates as the first implementation | Coordinates can be brittle across renderers, zoom, and pages. | Anchor by generated bullet/change text first; use PDF overlay only when anchors are stable. |
| Recomputing missing keywords from job keywords alone | It violates the project auditability rule and can mislabel generated material. | Use generation-time coverage or actual rendered resume text with provenance-backed coverage. |
| Hiding incomplete audit fields | It removes user value and masks source-of-truth gaps. | Show explicit missing-source states and fix the owning layer. |
| Real profile/resume/application data in tests or screenshots | Sensitive local artifacts must not be exposed. | Synthetic seeded fixtures and scrubbed screenshots only. |

## Version Compatibility

| Package/Layer | Compatible With | Notes |
|---------------|-----------------|-------|
| React 19 + Vite 7 | Current web app | Continue colocated component tests and Vite build checks. |
| Tailwind 4 CSS-first tokens | v1.1 shadcn token migration | Do not reintroduce `apps/web/tailwind.config.ts` assumptions. |
| `@jobhunter/contracts` DTOs | API read model and web Operations hooks | Contract additions must be reflected in API mappers and consuming hooks/components. |
| SQLite projections | Local-first API endpoints | Read model should deserialize/derive audit facts without requiring worker runs during QA. |

## Sources

- `package.json` - current scripts, package manager, TypeScript version, and verification commands.
- `apps/web/package.json` - current React/Vite/Tailwind/TanStack/Storybook/Playwright stack.
- `apps/web/src/views/jobs/JobDetailDrawer.tsx` - existing Jobs row-click drawer surface.
- `apps/web/src/views/apply-review/ApplyReviewView.tsx` - existing Apply Review queue, status derivation, and material preview surface.
- `packages/contracts/src/schemas.ts` - existing Apply Review, Job Detail, artifact, provenance, and tailoring explanation DTOs.
- `apps/api/src/application-feedback.ts` and `apps/api/src/read-model.ts` - current queue/detail read-model construction.
- `.planning/sketches/002-layered-audit-surfaces/` - chosen Option 1 sketch.

---
*Stack research for: v1.2 Apply Review Audit UX - Drawer + Resume Pins*
*Researched: 2026-06-11*
