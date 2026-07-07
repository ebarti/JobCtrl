import type { ContactResearchDetailResponse } from "@jobctl/contracts";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { outreachKeys } from "../queryKeys.js";

export function useResearchTaskQuery(
  taskId: string,
): UseQueryResult<ContactResearchDetailResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: outreachKeys.researchTask(tenantId, taskId),
    queryFn: () => api.researchTask(taskId),
    enabled: Boolean(taskId),
  });
}
