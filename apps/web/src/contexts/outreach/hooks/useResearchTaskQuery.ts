import type { ContactResearchDetailResponse } from "@jobctrl/contracts";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { outreachKeys } from "../queryKeys.js";

export type ResearchDetailResponse = Omit<ContactResearchDetailResponse, "task"> & {
  task: ContactResearchDetailResponse["task"] & { revision: number };
};

export function useResearchTaskQuery(
  taskId: string,
): UseQueryResult<ResearchDetailResponse> {
  const tenantId = useTenantId();
  const { http } = usePorts();
  return useQuery({
    queryKey: outreachKeys.researchTask(tenantId, taskId),
    queryFn: () => http.json<ResearchDetailResponse>("GET", `/v1/contacts/research/${encodeURIComponent(taskId)}`),
    enabled: Boolean(taskId),
  });
}
