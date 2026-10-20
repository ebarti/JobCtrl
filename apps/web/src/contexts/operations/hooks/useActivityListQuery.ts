import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { activityListQuery } from "../readQueries.js";
import type {
  ActivityEventSummary,
  PaginatedResponse,
} from "@jobctrl/contracts";
import type { ActivityListInput } from "../types.js";

export function useActivityListQuery(
  input: ActivityListInput,
): UseQueryResult<PaginatedResponse<ActivityEventSummary>> {
  const { api } = usePorts();
  const tenantId = useTenantId();
  return useQuery({
    ...activityListQuery({ tenantId, ports: { api } }, input),
  });
}
