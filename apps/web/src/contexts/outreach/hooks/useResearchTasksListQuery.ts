import type { ContactResearchListResponse } from "@jobctl/contracts";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { outreachKeys } from "../queryKeys.js";

export type ResearchTasksFilters = {
  jobId?: string;
  employer?: string;
};

export function useResearchTasksListQuery(
  filters: ResearchTasksFilters = {},
): UseQueryResult<ContactResearchListResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: outreachKeys.researchTaskList(tenantId, filters),
    queryFn: () => api.researchTasks(filters),
  });
}
