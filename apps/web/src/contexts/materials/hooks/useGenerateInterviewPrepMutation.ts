import type { ActionRunResponse } from "@jobctrl/contracts";
import type { GenerateInterviewPrepRequest } from "../../operations/types.js";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { interviewKeys } from "../../operations/interviewKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import type { JobId } from "../../operations/types.js";

export interface GenerateInterviewPrepVariables {
  readonly jobId: JobId;
  readonly body?: GenerateInterviewPrepRequest;
}

export function useGenerateInterviewPrepMutation(): UseMutationResult<
  ActionRunResponse,
  Error,
  GenerateInterviewPrepVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables) => variables.body ? api.generateInterviewPrep(variables.jobId, variables.body) : api.generateInterviewPrep(variables.jobId),
    onSettled: (_data, _error, variables) => {
      void queryClient.invalidateQueries({ queryKey: interviewKeys.history(tenantId, variables.jobId) });
      void queryClient.invalidateQueries({ queryKey: jobsKeys.detail(tenantId, variables.jobId) });
      void queryClient.invalidateQueries({ queryKey: jobsKeys.lists(tenantId) });
      void queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(tenantId) });
    },
  });
}
