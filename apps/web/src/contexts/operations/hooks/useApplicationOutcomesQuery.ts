import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { outcomesKeys } from "../outcomesKeys.js";
import type { ApplicationOutcomeListResponse } from "../types.js";

export function useApplicationOutcomesQuery(): UseQueryResult<ApplicationOutcomeListResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: outcomesKeys.list(tenantId),
    queryFn: () => api.applicationOutcomes(),
  });
}
