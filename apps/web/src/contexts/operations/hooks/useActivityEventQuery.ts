import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { dashboardKeys } from "../dashboardKeys.js";
import type { DashboardSummary } from "../types.js";

export type ActivityEvent = DashboardSummary["activity"][number];

export function useActivityEventQuery(eventId: string): UseQueryResult<ActivityEvent | null> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: dashboardKeys.summary(tenantId),
    queryFn: () => api.dashboardSummary(),
    select: (summary) =>
      summary.activity.find((entry) => entry.eventId === eventId) ?? null,
  });
}
