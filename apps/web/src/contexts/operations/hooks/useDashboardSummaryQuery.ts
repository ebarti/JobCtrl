import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { dashboardSummaryQuery } from "../readQueries.js";
import type { DashboardSummary } from "@jobctrl/contracts";

export function useDashboardSummaryQuery(): UseQueryResult<DashboardSummary> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    ...dashboardSummaryQuery({ tenantId, ports: { api } }),
    staleTime: 0,
    refetchOnMount: "always",
  });
}
