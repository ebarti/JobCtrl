import type { ContactResearchListResponse } from "@jobctrl/contracts";
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
  const { http } = usePorts();
  return useQuery({
    queryKey: outreachKeys.researchTaskList(tenantId, filters),
    queryFn: () => http.json<ContactResearchListResponse>("GET", "/v1/contacts/research", { query: filters }),
  });
}
