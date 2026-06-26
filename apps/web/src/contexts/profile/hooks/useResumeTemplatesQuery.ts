import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import type { ResumeTemplateListResponse } from "@jobhunter/contracts";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { profileKeys } from "../queryKeys.js";

export function useResumeTemplatesQuery(): UseQueryResult<ResumeTemplateListResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: profileKeys.resumeTemplates(tenantId),
    queryFn: () => api.resumeTemplates(),
  });
}
