import type { JobUrlImportResponse } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { invalidateCompletedJobUrlImport } from "../../operations/jobUrlImport.js";
import { workflowRunsKeys } from "../../operations/workflowRunsKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";

export interface ImportJobVariables {
  readonly url: string;
}

export function useImportJobMutation(): UseMutationResult<
  JobUrlImportResponse,
  Error,
  ImportJobVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [...jobsKeys.all(tenantId), "import-url"],
    mutationFn: (body) => api.importJobUrl({ ...body, awaitResult: false }),
    onSuccess: async (result) => {
      if (result.status === "started") {
        void queryClient.invalidateQueries({ queryKey: workflowRunsKeys.all(tenantId) });
        return;
      }
      await invalidateCompletedJobUrlImport(queryClient, tenantId, result);
    },
  });
}
