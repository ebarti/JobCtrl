import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { dashboardKeys } from "../dashboardKeys.js";
import type { DashboardSummary } from "../types.js";

export function useDashboardSummaryQuery(): UseQueryResult<DashboardSummary> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: dashboardKeys.summary(tenantId),
    queryFn: () => api.dashboardSummary(),
    staleTime: 0,
    refetchOnMount: "always",
  });
}
