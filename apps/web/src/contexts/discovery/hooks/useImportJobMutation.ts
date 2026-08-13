import type { JobUrlImportResponse } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import { discoveryKeys } from "../queryKeys.js";

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
    mutationFn: (body) => api.importJobUrl(body),
    onSuccess: async (result) => {
      if (result.status === "imported") {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: jobsKeys.lists(tenantId) }),
          queryClient.invalidateQueries({ queryKey: jobsKeys.details(tenantId) }),
          queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(tenantId) }),
        ]);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: discoveryKeys.manualCapture(tenantId) });
    },
  });
}
