import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import type { WorkflowRunDetail } from "../types.js";
import { workflowRunsKeys } from "../workflowRunsKeys.js";

export function useWorkflowRunDetailQuery(
  runId: string,
): UseQueryResult<WorkflowRunDetail> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: workflowRunsKeys.detail(tenantId, runId),
    queryFn: () => api.workflowRun(runId),
    enabled: runId.length > 0,
  });
}
