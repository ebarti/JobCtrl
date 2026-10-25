import type { JobUrlImportExecution, JobUrlImportStatusResponse } from "@jobctrl/contracts";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { discoveryKeys } from "../queryKeys.js";
import { invalidateCompletedJobUrlImport } from "../jobUrlImport.js";

export function useJobUrlImportStatusQuery(
  execution: JobUrlImportExecution | undefined,
): UseQueryResult<JobUrlImportStatusResponse, Error> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: discoveryKeys.jobUrlImportStatus(tenantId, execution?.workflowId ?? "", execution?.executionId ?? ""),
    enabled: execution !== undefined,
    queryFn: async () => {
      if (!execution) throw new Error("No import execution selected.");
      const result = await api.jobUrlImportStatus(execution);
      if (result.status === "imported" || result.status === "manual_capture_required") {
        void invalidateCompletedJobUrlImport(queryClient, tenantId, result);
      }
      return result;
    },
    retry: 2,
    refetchOnWindowFocus: false,
    refetchIntervalInBackground: true,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === undefined || status === "pending" ? 2_000 : false;
    },
  });
}
