# Phase 17: Source Registry & Access Policy - Pattern Map

**Mapped:** 2026-06-19
**Files analyzed:** 13
**Analogs found:** 13 / 13

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `packages/contracts/src/schemas.ts` | contract | request-response | `SourceRegistry*` DTOs in `packages/contracts/src/schemas.ts` | exact |
| `apps/api/src/compensation-source-policy.ts` | service/utility | request-response | `apps/api/src/discovery-controls.ts` | exact |
| `apps/api/src/server.ts` | route | request-response | `/v1/discovery/sources` route in `apps/api/src/server.ts` | exact |
| `packages/api-client/src/client.ts` | client | request-response | `discoverySources()` in `packages/api-client/src/client.ts` | exact |
| `apps/api/test/compensation-source-policy.test.ts` | test | request-response | `apps/api/test/discovery-controls.test.ts` | exact |
| `apps/web/src/contexts/operations/types.ts` | type re-export | transform | discovery source type exports in `apps/web/src/contexts/operations/types.ts` | exact |
| `apps/web/src/contexts/compensation/queryKeys.ts` or existing context key file | config | request-response | `apps/web/src/contexts/discovery/queryKeys.ts` | exact |
| `apps/web/src/contexts/operations/hooks/useCompensationSourcePolicyQuery.ts` | hook | request-response | `useSourceRegistryQuery()` in `apps/web/src/contexts/operations/hooks/useDiscoveryProductControlsQuery.ts` | exact |
| `apps/web/src/contexts/compensation/components/CompensationSourcePolicy.tsx` | component | request-response | `SourceRegistryPanel` in `apps/web/src/contexts/discovery/components/DiscoveryProductControls.tsx` | role-match |
| `apps/web/src/contexts/compensation/components/CompensationSourcePolicy.test.tsx` | test | request-response | `DiscoveryProductControls.test.tsx` | exact |
| `apps/web/src/test/msw/handlers.ts` | test fixture | request-response | discovery source MSW handlers in same file | exact |
| `workers/automation/src/jobhunter/domain/compensation/source_registry.py` | model | transform | `workers/automation/src/jobhunter/domain/discovery/source_registry.py` | role-match |
| `workers/automation/src/jobhunter/database.py` | persistence | CRUD | `ensure_profile_tables()` compensation columns in `database.py` | role-match |

## Pattern Assignments

### `packages/contracts/src/schemas.ts` (contract, request-response)

**Analog:** `packages/contracts/src/schemas.ts`

**Copy the enum/type layout** from discovery source contracts: const arrays with `as const`, derived union types, interfaces for response DTOs, and strict Zod schemas for request bodies.

```typescript
export const SOURCE_KIND_VALUES = [
  "ats_api",
  "employer_careers_page",
  "official_api",
  "licensed_feed",
  "niche_board",
  "broad_board",
  "smart_extract",
  "user_mediated_capture",
] as const;
export type SourceKindValue = (typeof SOURCE_KIND_VALUES)[number];

export interface SourceRegistryListResponse {
  ok: true;
  sources: SourceRegistryEntrySummary[];
}
```

Source: `packages/contracts/src/schemas.ts` lines 2016-2079.

**Validation pattern:** request schemas use `z.object(...).strict()`, `.trim()`, bounded lengths, enum references, and defaults.

```typescript
export const SourceUpsertRequestSchema = z
  .object({
    sourceId: z.string().trim().min(1).max(160),
    kind: z.enum(SOURCE_KIND_VALUES),
    displayName: z.string().trim().min(1).max(160),
    priority: z.enum(SOURCE_PRIORITY_VALUES).default("standard"),
    state: z.enum(SOURCE_STATE_VALUES).default("experimental"),
  })
  .strict();
export type SourceUpsertRequest = z.infer<typeof SourceUpsertRequestSchema>;
```

Source: `packages/contracts/src/schemas.ts` lines 2267-2282.

**Apply to compensation:** define compensation-specific values such as `COMPENSATION_SOURCE_TYPE_VALUES`, `COMPENSATION_ACCESS_MODE_VALUES`, `COMPENSATION_LICENSE_STATE_VALUES`, `COMPENSATION_SOURCE_STATE_VALUES`, `COMPENSATION_SUPPORTED_FIELD_VALUES`, plus `CompensationSourcePolicySummary` and `CompensationSourcePolicyResponse`. Keep DTOs safe: no credentials, raw provider payloads, paths, private account data, or scraped content.

### `apps/api/src/compensation-source-policy.ts` (service/utility, request-response)

**Analog:** `apps/api/src/discovery-controls.ts`

**Imports pattern:** import contract types and value arrays from `./contracts.js`; import SQLite helpers from `./db.js`; keep route-independent logic in the service module.

```typescript
import type {
  SourceRegistryEntrySummary,
  SourceRegistryListResponse,
  SourceStatePatch,
  SourceStateValue,
  SourceUpsertRequest,
  SourceKindValue,
} from "./contracts.js";
import {
  SOURCE_KIND_VALUES,
  SOURCE_PRIORITY_VALUES,
  SOURCE_STATE_VALUES,
} from "./contracts.js";
import { allRows, getRow, tableExists, type SqliteDatabase } from "./db.js";
```

Source: `apps/api/src/discovery-controls.ts` lines 3-45.

**Row shape pattern:** keep DB rows snake_case and map them into camelCase DTOs at the boundary.

```typescript
interface SourceRegistryRow extends Record<string, unknown> {
  tenant_id: string;
  source_id: string;
  kind: string;
  display_name: string;
  owner: string;
  priority: string;
  state: string;
  policy_id: string;
  seed_url: string | null;
  created_at: string;
  updated_at: string;
}
```

Source: `apps/api/src/discovery-controls.ts` lines 87-99.

**Read endpoint core pattern:** ensure backing data exists, build deterministic rows, combine optional stats/read-model data, sort in SQL, and return `{ ok: true, ... }`.

```typescript
export function listSourceRegistry(db: SqliteDatabase): SourceRegistryListResponse {
  ensureDiscoveryControlTables(db);
  refreshProjections(db, DEFAULT_TENANT);

  const rows = allRows<SourceRegistryRow>(
    db,
    `SELECT tenant_id, source_id, kind, display_name, owner, priority, state,
            policy_id, seed_url, created_at, updated_at
     FROM source_registry_entries
     WHERE tenant_id = ?
     ORDER BY state ASC, priority ASC, display_name ASC`,
    [DEFAULT_TENANT],
  );
  return { ok: true, sources: [...summaries.values()] };
}
```

Source: `apps/api/src/discovery-controls.ts` lines 408-445.

**Mapping pattern:** centralize type coercion and fallbacks; do not leak raw DB strings directly.

```typescript
function rowToSourceSummary(
  row: SourceRegistryRow,
  stats: SourceQualityRow | undefined,
): SourceRegistryEntrySummary {
  return {
    sourceId: row.source_id,
    kind: sourceKind(row.kind),
    displayName: row.display_name,
    owner: row.owner === "system" ? "system" : "user",
    priority: sourcePriority(row.priority),
    state: sourceState(row.state),
    policyId: row.policy_id,
    recommendedState: recommendedSourceState(stats?.recommended_state),
  };
}

function sourceKind(value: string): SourceKindValue {
  return SOURCE_KIND_VALUES.includes(value as SourceKindValue) ? (value as SourceKindValue) : "broad_board";
}
```

Source: `apps/api/src/discovery-controls.ts` lines 1259-1283 and 1359-1364.

**Apply to compensation:** prefer a deterministic in-code seed list unless persistence is needed immediately. If persisted, mirror `ensureDiscoveryControlTables()` but with compensation-specific rows and tenant `local`. Include public Europe sources and disabled licensed seams as policy metadata only. No network fetches.

### `apps/api/src/server.ts` (route, request-response)

**Analog:** `apps/api/src/server.ts`

**Import/export convention:** route modules are imported into `server.ts` from relative `.js` files; contract schemas come from `./contracts.js`.

```typescript
import {
  DiscoverySettingsUpdateRequestSchema,
  SourceStatePatchSchema,
  SourceUpsertRequestSchema,
} from "./contracts.js";
import {
  listSourceRegistry,
  patchSourceState,
  upsertSourceRegistryEntry,
} from "./discovery-controls.js";
```

Source: `apps/api/src/server.ts` lines 10-64 and 73-91.

**Read route pattern:** simple GET routes use `withDb(reply, options.dbPath, (db) => service(db))`.

```typescript
app.get("/v1/discovery/sources", async (_request, reply) =>
  withDb(reply, options.dbPath, (db) => listSourceRegistry(db)),
);
```

Source: `apps/api/src/server.ts` lines 257-259.

**Mutation edge pattern if later needed:** parse contract schema at the route edge with `parseBody`, then call `withWritableDb`.

```typescript
const body = parseBody(reply, SourceUpsertRequestSchema, request.body ?? {});
if (!body) {
  return undefined;
}
return withWritableDb(reply, options.dbPath, (db) => ({
  ok: true,
  source: upsertSourceRegistryEntry(db, body),
}));
```

Source: `apps/api/src/server.ts` lines 273-281.

**Apply to compensation:** add a read-only route such as `GET /v1/compensation/sources` or `GET /v1/compensation/source-policy`. Keep it GET-only in Phase 17 unless planning explicitly adds admin mutation.

### `packages/api-client/src/client.ts` (client, request-response)

**Analog:** `packages/api-client/src/client.ts`

**Import convention:** import DTO types from `@jobhunter/contracts` at the top-level type-only import.

```typescript
import type {
  SourceRegistryListResponse,
  SourceRegistryMutationResponse,
  SourceStatePatch,
  SourceUpsertRequest,
} from "@jobhunter/contracts";
```

Source: `packages/api-client/src/client.ts` lines 1-84.

**Client method pattern:** one typed method per route, using private `get/post/patch` helpers and `encodeURIComponent` for path params.

```typescript
discoverySources(): Promise<SourceRegistryListResponse> {
  return this.get("/v1/discovery/sources");
}
```

Source: `packages/api-client/src/client.ts` lines 150-151.

**Apply to compensation:** add `compensationSources(): Promise<CompensationSourcePolicyResponse>` returning `this.get("/v1/compensation/sources")`.

### `apps/api/test/compensation-source-policy.test.ts` (test, request-response)

**Analog:** `apps/api/test/discovery-controls.test.ts`

**Harness pattern:** use `better-sqlite3`, a temp directory, `buildApp(options)`, and `app.inject`. Close app and clean temp files in `finally`.

```typescript
function withTempDb(): { dbPath: string; dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobhunter-api-discovery-controls-"));
  const dbPath = path.join(dir, "jobs.db");
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE jobs (...);`);
  db.close();
  return { dbPath, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const response = await app.inject({ method: "GET", url: "/v1/discovery/sources" });
expect(response.statusCode, response.body).toBe(200);
```

Source: `apps/api/test/discovery-controls.test.ts` lines 1-51 and 223-225.

**Policy test cases to copy:** assert deterministic public Europe entries exist; licensed seams are present but disabled/unavailable; response contains access/license/attribution/supported fields; response does not include credentials, raw payload, local paths, private account data, scraped content, or live network-dependent values.

### `apps/web/src/contexts/operations/types.ts` (type re-export, transform)

**Analog:** `apps/web/src/contexts/operations/types.ts`

**Pattern:** import types from `@jobhunter/contracts`, then re-export them from `operations/types.ts` so hooks/components consume the Operations type surface.

```typescript
import type {
  SourceRegistryEntrySummary,
  SourceRegistryListResponse,
  SourceRegistryMutationResponse,
  SourceStatePatch,
  SourceUpsertRequest,
} from "@jobhunter/contracts";

export type {
  SourceRegistryEntrySummary,
  SourceRegistryListResponse,
  SourceRegistryMutationResponse,
  SourceStatePatch,
  SourceUpsertRequest,
};
```

Source: `apps/web/src/contexts/operations/types.ts` lines 1-63 and 66-121.

**Apply to compensation:** add `CompensationSourcePolicySummary` and `CompensationSourcePolicyResponse` here if a web hook/UI is included.

### `apps/web/src/contexts/compensation/queryKeys.ts` (config, request-response)

**Analog:** `apps/web/src/contexts/discovery/queryKeys.ts`

**Pattern:** tenant first, context second, stable subset name third.

```typescript
import type { TenantId } from "@jobhunter/domain-types";

export const discoveryKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "discovery"] as const,
  sourceRegistry: (tenantId: TenantId) =>
    ["tenant", tenantId, "discovery", "source-registry"] as const,
};
```

Source: `apps/web/src/contexts/discovery/queryKeys.ts` lines 1-23.

**Apply to compensation:** use `["tenant", tenantId, "compensation", "source-policy"] as const` or `["tenant", tenantId, "compensation", "sources"] as const`. Do not put this under discovery keys if creating a compensation context.

### `apps/web/src/contexts/operations/hooks/useCompensationSourcePolicyQuery.ts` (hook, request-response)

**Analog:** `apps/web/src/contexts/operations/hooks/useDiscoveryProductControlsQuery.ts`

**Pattern:** Operations read hook gets `tenantId`, gets `api` via `usePorts()`, uses tenant-scoped key, calls the API port, and sets `staleTime: 0`.

```typescript
export function useSourceRegistryQuery(): UseQueryResult<SourceRegistryListResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: discoveryKeys.sourceRegistry(tenantId),
    queryFn: () => api.discoverySources(),
    staleTime: 0,
  });
}
```

Source: `apps/web/src/contexts/operations/hooks/useDiscoveryProductControlsQuery.ts` lines 1-23.

**Apply to compensation:** `useCompensationSourcePolicyQuery()` should call `api.compensationSources()` through ports. Do not call `apiClient` directly in a component.

### `apps/web/src/contexts/compensation/components/CompensationSourcePolicy.tsx` (component, request-response)

**Analog:** `apps/web/src/contexts/discovery/components/DiscoveryProductControls.tsx`

**Import convention:** contract types first, icons, React hooks, Operations hooks, then shared UI.

```typescript
import type { SourceRegistryEntrySummary } from "@jobhunter/contracts";
import { IconBan, IconCheck, IconEye, IconPlus } from "@tabler/icons-react";
import { type FormEvent, useMemo, useState } from "react";

import { useSourceRegistryQuery } from "../../operations/hooks/useDiscoveryProductControlsQuery.js";
import { Button } from "../../../shared/ui/button.js";
import { CardHeader } from "../../../shared/ui/card-header.js";
import { FilterableDataGrid, type DataGridColumn } from "../../../shared/ui/filterable-data-grid.js";
import { StatusDot } from "../../../shared/ui/status-dot.js";
```

Source: `apps/web/src/contexts/discovery/components/DiscoveryProductControls.tsx` lines 1-58.

**Inspection surface pattern:** top-level component calls Operations hooks, derives counts and error message, then passes plain data into a panel.

```tsx
const sources = useSourceRegistryQuery();
const sourceCount = sources.data?.sources.length ?? 0;
const message = sources.error instanceof Error ? sources.error.message : null;

return (
  <section className="card full discovery-controls">
    <CardHeader title="Discovery controls" meta={`${sourceCount} sources`} />
    {message ? <div className="banner inline">{message}</div> : null}
    <SourceRegistryPanel sources={sources.data?.sources ?? []} loading={sources.isLoading} />
  </section>
);
```

Source: `apps/web/src/contexts/discovery/components/DiscoveryProductControls.tsx` lines 365-455.

**Grid pattern:** use `FilterableDataGrid` with stable `getRowId`, memoized `DataGridColumn[]`, explicit sort/filter values, loading/empty messages, and pagination.

```tsx
const sourceColumns = useMemo<Array<DataGridColumn<SourceRegistryEntrySummary>>>(
  () => [
    {
      id: "displayName",
      label: "Company",
      rowHeader: true,
      render: (source) => <span>{source.displayName}</span>,
      getSortValue: (source) => source.displayName.toLowerCase(),
      getFilterValue: (source) => source.displayName,
    },
  ],
  [],
);

<FilterableDataGrid
  title="Grid view"
  data={sources}
  columns={sourceColumns}
  getRowId={(source) => source.sourceId}
  loading={loading}
  loadingMessage="Loading sources."
  emptyMessage="No sources registered."
  initialSort={{ columnId: "displayName", direction: "asc" }}
  paginate
  initialPageSize={25}
/>;
```

Source: `apps/web/src/contexts/discovery/components/DiscoveryProductControls.tsx` lines 467-570 and 780-793.

**Apply to compensation:** keep the UI small: a read-only source policy table with columns like Source, Type, Access mode, License state, Availability, Freshness, Attribution, Supported fields, Disabled reason. Do not add mutation forms unless Phase 17 explicitly scopes editable policy.

### `apps/web/src/contexts/compensation/components/CompensationSourcePolicy.test.tsx` (test, request-response)

**Analog:** `apps/web/src/contexts/discovery/components/DiscoveryProductControls.test.tsx`

**Harness pattern:** use `renderWithProviders`, override ports with `buildTestPorts`, and assert screen-visible behavior plus API port calls where applicable.

```typescript
renderWithProviders(<DiscoveryProductControls />, {
  ports: buildTestPorts({
    api: {
      discoverySources: vi.fn(async () => ({
        ok: true as const,
        sources: [{ sourceId: "readable-source", displayName: "Readable Source" }],
      })),
    },
  }),
});

await screen.findByText("Readable Source");
expect(screen.getByLabelText("Source registry summary")).toHaveTextContent("1 active");
```

Source: `apps/web/src/contexts/discovery/components/DiscoveryProductControls.test.tsx` lines 1-89.

**Interaction/filtering pattern:** for grid behavior, use `userEvent`, `within(table)`, and accessible names.

```typescript
const user = userEvent.setup();
await user.click(screen.getByRole("button", { name: /filter company column/i }));
await user.type(screen.getByLabelText("Company filter text"), "sales");
expect(within(sourceTable).getByText("Salesforce")).toBeInTheDocument();
```

Source: `apps/web/src/contexts/discovery/components/DiscoveryProductControls.test.tsx` lines 95-176.

### `apps/web/src/test/msw/handlers.ts` (test fixture, request-response)

**Analog:** `apps/web/src/test/msw/handlers.ts`

**Pattern:** define a sample object near the top, add REST handlers to the shared `handlers` array, and return deterministic JSON.

```typescript
const sampleDiscoverySource = {
  sourceId: "greenhouse-example",
  kind: "ats_api",
  displayName: "Greenhouse Example",
  owner: "user",
  priority: "canonical",
  state: "experimental",
  policyId: "local:greenhouse-example",
  recommendedState: "normal",
};

export const handlers = [
  http.get("*/v1/discovery/sources", () =>
    HttpResponse.json({ ok: true, sources: [sampleDiscoverySource] }),
  ),
];
```

Source: `apps/web/src/test/msw/handlers.ts` lines 1-84.

**Apply to compensation:** add `sampleCompensationSourcePolicy` and a `http.get("*/v1/compensation/sources", ...)` handler in this file. Do not create a second MSW setup.

### `workers/automation/src/jobhunter/domain/compensation/source_registry.py` (model, transform)

**Analog:** `workers/automation/src/jobhunter/domain/discovery/source_registry.py`

**Enum/policy pattern:** domain vocabulary lives in `str, Enum`; immutable policies and entries are `@dataclass(frozen=True)` with validation in `__post_init__`.

```python
class SourceKind(str, Enum):
    ATS_API = "ats_api"
    OFFICIAL_API = "official_api"
    LICENSED_FEED = "licensed_feed"
    BROAD_BOARD = "broad_board"

@dataclass(frozen=True)
class SourcePolicy:
    policy_id: str
    allowed_methods: tuple[SourcePolicyMethod, ...]
    authentication: SourceAuthenticationMode = SourceAuthenticationMode.NONE
    attribution: str = "none"
    max_pages_per_run: int = 100
    max_run_frequency: str = "PT24H"

    def __post_init__(self) -> None:
        if not isinstance(self.policy_id, str) or not self.policy_id.strip():
            raise ValueError("SourcePolicy.policy_id must be a non-empty string")
```

Source: `workers/automation/src/jobhunter/domain/discovery/source_registry.py` lines 1-120.

**Entry validation pattern:**

```python
@dataclass(frozen=True)
class SourceRegistryEntry:
    tenant_id: TenantId
    source_id: str
    kind: SourceKind
    display_name: str
    owner: str
    priority: SourcePriority
    state: SourceState
    policy: SourcePolicy

    def __post_init__(self) -> None:
        if not isinstance(self.source_id, str) or not self.source_id.strip():
            raise ValueError("SourceRegistryEntry.source_id must be a non-empty string")
        if self.owner not in {"system", "user"}:
            raise ValueError("SourceRegistryEntry.owner must be 'system' or 'user'")
```

Source: `workers/automation/src/jobhunter/domain/discovery/source_registry.py` lines 178-198.

**Apply to compensation:** model access mode, license state, attribution requirement, supported fields, disabled reason, freshness policy, and Europe coverage as explicit enum/value-object fields. For Glassdoor and Levels.fyi, default to disabled/unavailable unless permitted access is configured; no scrape/fetch/cache methods in Phase 17.

### `workers/automation/src/jobhunter/database.py` (persistence, CRUD)

**Analog:** `workers/automation/src/jobhunter/database.py`

**Schema pattern:** worker DB helpers create normalized local tables with tenant defaults and typed columns. Existing compensation profile columns are plain relational columns, not JSON blobs.

```python
def ensure_profile_tables(conn: sqlite3.Connection | None = None) -> list[str]:
    if conn is None:
        conn = get_connection()

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS candidate_profiles (
            tenant_id                         TEXT NOT NULL DEFAULT 'local',
            profile_id                        TEXT NOT NULL DEFAULT 'default',
            compensation_salary_expectation   TEXT NOT NULL DEFAULT '',
            compensation_salary_currency      TEXT NOT NULL DEFAULT 'USD',
            compensation_salary_range_min     TEXT NOT NULL DEFAULT '',
            compensation_salary_range_max     TEXT NOT NULL DEFAULT '',
            compensation_currency_note        TEXT NOT NULL DEFAULT '',
        """
    )
```

Source: `workers/automation/src/jobhunter/database.py` lines 480-545.

**Apply to compensation:** only add persistence if needed by later adapter seams. If the registry is static for Phase 17, do not create DB tables. If persisted, use tenant-scoped rows and deterministic seed/upsert behavior, not raw provider blobs.

## Shared Patterns

### Local API Boundary

**Source:** `apps/api/src/server.ts` and `apps/api/src/discovery-controls.ts`

Apply to API route + service:
- Contract imports from `./contracts.js`.
- Service imports DB helpers from `./db.js`.
- GET route wraps with `withDb`.
- Mutations, if any, parse Zod schemas at the edge and use `withWritableDb`.
- Responses use `{ ok: true, ... }`.

### Deterministic Safe Metadata

**Source:** `apps/api/src/discovery-controls.ts`

Apply to compensation source policy:
- DB/static rows are internal snake_case or enum values.
- DTO mapper produces camelCase and enum-safe fallbacks.
- Missing optional quality/policy fields become `null`, `0`, or explicit unavailable states.
- Do not expose credentials, private account fields, raw payloads, local paths, scraped page content, or provider account details.

### Frontend Read Flow

**Source:** `apps/web/src/contexts/operations/hooks/useDiscoveryProductControlsQuery.ts`, `apps/web/src/contexts/discovery/queryKeys.ts`, and `apps/web/src/contexts/discovery/components/DiscoveryProductControls.tsx`

Apply to compensation UI:
- Query key: `["tenant", tenantId, "compensation", "..."] as const`.
- Hook lives in `contexts/operations/hooks`.
- Hook reads API through `usePorts()`.
- Domain/context component consumes the hook and renders shared UI.
- Components never import `apiClient` or call `fetch`.

### Test Harnesses

**Source:** `apps/api/test/discovery-controls.test.ts`, `DiscoveryProductControls.test.tsx`, `apps/web/src/test/msw/handlers.ts`

Apply to Phase 17:
- API: `buildApp`, temp SQLite DB, `app.inject`, cleanup in `finally`.
- Web unit/component: `renderWithProviders`, `buildTestPorts`, `screen`, `within`, `userEvent`.
- MSW: add the REST fixture to the existing shared handler array.

## Anti-Patterns To Avoid

| Anti-pattern | Why |
|---|---|
| Reusing the Discovery source registry semantics for compensation sources | Phase context says compensation needs separate licensing, attribution, freshness, access, and supported-field semantics. |
| Fetching, scraping, caching, or displaying Levels.fyi/Glassdoor salary data | Phase 17 only defines disabled/licensed seams unless permitted access is configured. |
| Putting source policy on job list/detail compensation audit contracts | Later phases own job-level facts and triage UX. Phase 17 owns registry inspection only. |
| Returning raw provider payloads, credentials, account details, local paths, or scraped content | API response must be safe policy metadata only. |
| Direct frontend calls to `apiClient`, `fetch`, `localStorage`, or `EventSource` | Repo convention requires ports and Operations hooks. |
| Creating a new MSW setup | Add handlers to `apps/web/src/test/msw/handlers.ts`. |
| View-owned query logic | Views compose; context components and Operations hooks own data access. |
| Network-dependent tests | Registry endpoint must be deterministic and local-first. |
| Broad final Jobs salary UX in this phase | Phase 21 owns Jobs list/drawer salary triage. |

## No Analog Found

None. Every planned surface has a close existing analog. The only semantic gap is domain-specific: compensation source policy must use its own vocabulary rather than Discovery source semantics.

## Metadata

**Analog search scope:** requested files plus phase context in `.planning/phases/17-source-registry-access-policy/17-CONTEXT.md`
**Files scanned:** 13 requested files + 1 phase context file
**Pattern extraction date:** 2026-06-19
