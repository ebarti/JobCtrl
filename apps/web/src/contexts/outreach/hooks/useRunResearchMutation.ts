import type { ContactResearchStartResponse, RunContactResearchRequest } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { outreachKeys } from "../queryKeys.js";

/**
 * Start a supervised research run. Plain `useMutation` (not
 * `createOptimisticMutation`) by design: the server mints the task id and starts
 * an async Temporal workflow, so the task does not exist client-side until the
 * response returns — there is no meaningful optimistic shape to patch (the
 * documented exception in CLAUDE.md's optimistic-mutation rule). The queued task
 * is invalidated in on settle; its running/needs_review state arrives via SSE.
 */
export function useRunResearchMutation(): UseMutationResult<
  ContactResearchStartResponse,
  Error,
  RunContactResearchRequest
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: outreachKeys.researchTasks(tenantId),
    mutationFn: (body: RunContactResearchRequest) => api.runContactResearch(body),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: outreachKeys.researchTaskLists(tenantId) });
    },
  });
}
