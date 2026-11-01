import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import type { WorkflowRunDetail } from "@jobctrl/contracts";
import { workflowRunsKeys } from "../workflowRunsKeys.js";

export function useWorkflowRunDetailQuery(
  runId: string,
  jobId?: string,
): UseQueryResult<WorkflowRunDetail> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: jobId ? workflowRunsKeys.jobDetail(tenantId, runId, jobId) : workflowRunsKeys.detail(tenantId, runId),
    queryFn: () => api.workflowRun(runId, jobId),
    enabled: runId.length > 0,
  });
}
