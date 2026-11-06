import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { profileKeys } from "../queryKeys.js";
import { readResumeTemplates, type TemplateList } from "../client.js";

export function useResumeTemplatesQuery(): UseQueryResult<TemplateList> {
  const tenantId = useTenantId();
  const { http } = usePorts();
  return useQuery({
    queryKey: profileKeys.resumeTemplates(tenantId),
    queryFn: () => readResumeTemplates(http),
  });
}
