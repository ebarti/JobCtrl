import type { ResetStaleScoresForRescoreResponse } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { useToastStore } from "../../../shared/stores/toasts.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import type { JobId } from "../../operations/types.js";

export interface ResetStaleScoresForRescoreVariables {
  readonly jobKeys?: readonly JobId[];
  readonly limit?: number;
}

export function useResetStaleScoresForRescoreMutation(): UseMutationResult<
  ResetStaleScoresForRescoreResponse,
  Error,
  ResetStaleScoresForRescoreVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    ...createOptimisticMutation<
      ResetStaleScoresForRescoreResponse,
      ResetStaleScoresForRescoreVariables
    >(queryClient, {
      mutationFn: ({ jobKeys = [], limit = 0 }) =>
        api.resetStaleScoresForRescore({ jobKeys: [...jobKeys], limit }),
      settle: (variables, data) => {
        const jobKeys = data?.jobKeys.length
          ? data.jobKeys
          : [...(variables.jobKeys ?? [])];
        return [
          jobsKeys.lists(tenantId),
          dashboardKeys.summary(tenantId),
          ...(jobKeys.length
            ? jobKeys.map((jobKey) => jobsKeys.detail(tenantId, jobKey))
            : [jobsKeys.details(tenantId)]),
        ];
      },
    }),
    onSuccess: (data) => {
      const active = data.skippedActiveJobKeys?.length ?? 0;
      const pending = data.alreadyPendingJobKeys?.length ?? 0;
      if (!active && !pending) return;
      const summary = `${data.count} ${data.count === 1 ? "score was" : "scores were"} reset.`;
      const activeMessage = active
        ? ` ${active} ${active === 1 ? "score has" : "scores have"} queued or running work or a recorded owner. Check score activity; wait for scoring to finish, then retry reset if still stale.`
        : "";
      const pendingMessage = pending
        ? ` ${pending} ${pending === 1 ? "score is" : "scores are"} already pending. Continue scoring and retry if still stale.`
        : "";
      useToastStore.getState().toast({ variant: "info", message: summary + activeMessage + pendingMessage });
    },
  });
}
