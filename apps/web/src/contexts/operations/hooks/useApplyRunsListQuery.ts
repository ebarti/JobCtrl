import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { dashboardKeys } from "../dashboardKeys.js";
import type { DashboardSummary } from "../types.js";

export type ApplyRunSummary = DashboardSummary["applyRuns"][number];

export function useApplyRunsListQuery(
  { enabled = true }: { readonly enabled?: boolean } = {},
): UseQueryResult<readonly ApplyRunSummary[]> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: dashboardKeys.summary(tenantId),
    queryFn: () => api.dashboardSummary(),
    select: (summary) => summary.applyRuns,
    enabled,
  });
}
