import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { analyticsKeys, type OutcomeAnalyticsFilters } from "../analyticsKeys.js";
import type { OutcomeAnalyticsSummary } from "../types.js";

export function useOutcomeAnalyticsQuery(
  filters: OutcomeAnalyticsFilters = {},
): UseQueryResult<OutcomeAnalyticsSummary> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: analyticsKeys.outcomes(tenantId, filters),
    queryFn: () => api.outcomeAnalytics(),
    staleTime: 0,
    refetchOnMount: "always",
  });
}
