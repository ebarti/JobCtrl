import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import type { OutcomeAnalyticsFilters } from "../analyticsKeys.js";
import { outcomeAnalyticsQuery } from "../readQueries.js";
import type { OutcomeAnalyticsSummary } from "@jobctrl/contracts";

export function useOutcomeAnalyticsQuery(
  filters: OutcomeAnalyticsFilters = {},
): UseQueryResult<OutcomeAnalyticsSummary> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    ...outcomeAnalyticsQuery({ tenantId, ports: { api } }, filters),
    staleTime: 0,
    refetchOnMount: "always",
  });
}
