# Phase 17: Source Registry & Access Policy - Context

**Gathered:** 2026-06-19
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 17 creates the compensation source registry and access-policy foundation for v1.3. Users must be able to inspect salary-source availability, access mode, license state, source type, freshness policy, attribution requirement, supported fields, and disabled/unavailable reasons before any compensation estimate is generated. This phase does not parse posted salaries, import Eurostat/INE datasets, estimate market ranges, or render the final Jobs triage compensation UX; those are later phases.

</domain>

<decisions>
## Implementation Decisions

### Source Policy Scope
- Use a compensation-specific registry, not the existing Discovery job-board registry, because salary evidence has different access, licensing, attribution, supported-field, and disabled-reason semantics.
- Seed v1.3 source entries for posted job salary text, Eurostat Structure of Earnings Survey, ESCO occupation mapping, Spain INE Wage Structure Survey, Levels.fyi, and Glassdoor.
- Mark public Europe sources as public/available or planned public baselines, and mark Levels.fyi and Glassdoor as disabled or unavailable licensed-source seams unless explicit permitted access is configured.
- Treat non-European public salary baselines as outside active product direction.

### Access Enforcement
- The registry must be inspectable without invoking external salary providers.
- Glassdoor must not be fetched, scraped, cached, or displayed as salary data without explicit partner/API access or written permission.
- Levels.fyi must not be fetched, scraped, cached, or displayed as salary data without an explicitly configured permitted access mode and Europe coverage.
- Phase 17 may define adapter seams and disabled statuses; it must not add live external calls to Levels.fyi or Glassdoor.

### API And Contracts
- Add typed DTOs to the existing contracts package and expose them through the local TypeScript API.
- Prefer an explicit read endpoint for compensation source policy, keeping the source registry separate from job list/detail compensation audit contracts that arrive in later phases.
- Ensure API responses expose safe policy metadata only: no credentials, raw provider payloads, local paths, private account details, or scraped page content.
- Keep the response local-first and deterministic so tests can assert source policy without network.

### Frontend Surface
- Phase 17 may expose the registry in a narrow inspection surface using existing Operations query hooks and context-owned compensation/source components.
- Do not build the final Jobs list/drawer salary triage in this phase; reserve that for Phase 21.
- If surfaced in the UI now, it should distinguish public Europe baselines from disabled licensed seams and avoid marketing copy or broad explanatory text.
- Follow the existing frontend architecture: Operations owns read hooks, context components own domain UI, and views remain composers.

### the agent's Discretion
- Choose exact storage location and whether Phase 17 persists source policy as code-seeded rows or a static registry module, provided the later phases can attach source evidence to canonical compensation facts.
- Choose whether the first UI exposure belongs in existing Discovery controls, Settings, or a compensation context component, provided source policy remains clearly separate from discovery job-board health.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `apps/api/src/server.ts` registers local REST routes and already exposes `/v1/discovery/sources` for the Discovery source registry.
- `apps/api/src/discovery-controls.ts` maps source registry rows into typed API summaries and has useful patterns for safe source metadata.
- `packages/contracts/src/schemas.ts` owns shared Zod schemas and DTO types used by API, client, and web.
- `packages/api-client/src/client.ts` owns typed API-client methods.
- `apps/web/src/contexts/operations/hooks/useDiscoveryProductControlsQuery.ts` shows the Operations read-hook pattern for source registry data.
- `apps/web/src/contexts/discovery/components/DiscoveryProductControls.tsx` and tests show table/filtering patterns for source inspection surfaces.
- `workers/automation/src/jobhunter/database.py` and Discovery production wiring already seed and persist discovery source registry rows; reuse style, not semantics.

### Established Patterns
- Local API route handlers parse contract schemas at the edge and return `{ ok: true, ... }` DTOs.
- Frontend reads go through Operations hooks and API ports; components do not call `apiClient` directly.
- Query keys are tenant-scoped under `["tenant", tenantId, ...]`.
- Tests are colocated for web, under `apps/api/test` for API behavior, and under `workers/automation/tests` for Python domain/storage behavior.
- Sensitive local data is never exposed through read-models, events, fixtures, or logs.

### Integration Points
- Contracts: add compensation source DTOs and response schemas.
- API: add a deterministic read route for compensation source registry/access policy.
- API client: add a corresponding method.
- Frontend Operations: add query key/hook/type exports for compensation source policy if a UI inspection surface is included.
- Worker/domain: add compensation source value objects or registry helpers only if needed to keep later source adapters from duplicating policy.

</code_context>

<specifics>
## Specific Ideas

- Public v1.3 baselines: Eurostat SES, ESCO, and Spain INE.
- Licensed seams: Levels.fyi and Glassdoor remain disabled/unavailable until permitted access is explicitly configured.
- The user clarified that JobHunter is Europe-first; avoid framing U.S. baselines as future active direction.
- Profile-floor behavior remains warning-only for v1.3, but comparison behavior is not part of Phase 17.

</specifics>

<deferred>
## Deferred Ideas

- Posted salary parsing and confidence facts belong to Phase 18.
- Public market estimate calculation and statistical confidence belong to Phase 19.
- Canonical compensation audit read-model and SSE updates belong to Phase 20.
- Jobs list and drawer salary triage UX belongs to Phase 21.
- End-to-end product-path QA belongs to Phase 22.

</deferred>
