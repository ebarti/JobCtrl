import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import type { PaginatedResponse, WorkflowRunSummary } from "@jobctrl/contracts";
import type { WorkflowRunsListInput } from "../types.js";
import { workflowRunsKeys } from "../workflowRunsKeys.js";

export function useWorkflowRunsListQuery(
  input: WorkflowRunsListInput = {},
): UseQueryResult<PaginatedResponse<WorkflowRunSummary>> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: workflowRunsKeys.list(tenantId, input),
    queryFn: () => api.workflowRuns(input),
  });
}
