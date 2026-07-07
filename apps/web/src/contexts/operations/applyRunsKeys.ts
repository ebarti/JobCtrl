import type { TenantId } from "@jobctrl/domain-types";

// The backend bundles apply runs in `DashboardSummary.applyRuns` rather than
// exposing a dedicated `/v1/apply-runs` endpoint. Today's `useApplyRunsListQuery`
// therefore keys on `dashboardKeys.summary(tenantId)` and derives via `select`
// (see hooks/useApplyRunsListQuery.ts). This factory is kept as the seam for the
// future dedicated endpoint per target §4.1; the §8.4 event → invalidation map
// will route `ApplyRun*` events here once the endpoint exists.
export const applyRunsKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "applyRuns"] as const,
  lists: (tenantId: TenantId) => [...applyRunsKeys.all(tenantId), "list"] as const,
  details: (tenantId: TenantId) => [...applyRunsKeys.all(tenantId), "detail"] as const,
  detail: (tenantId: TenantId, runId: string) =>
    [...applyRunsKeys.details(tenantId), runId] as const,
};
