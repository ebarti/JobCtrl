import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { activityKeys } from "../activityKeys.js";
import type {
  ActivityEventSummary,
  ActivityListInput,
  PaginatedResponse,
} from "../types.js";

export function useActivityListQuery(
  input: ActivityListInput,
): UseQueryResult<PaginatedResponse<ActivityEventSummary>> {
  const { api } = usePorts();
  const tenantId = useTenantId();
  return useQuery({
    queryKey: activityKeys.list(tenantId, input),
    queryFn: () => api.activity(input),
  });
}
