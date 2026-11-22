import type { ContactResearchStartResponse, RunContactResearchRequest } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { invalidateQueriesWithOptimisticOwnership } from "../../../shared/lib/createOptimisticMutation.js";
import { createUnconfirmedWriteError } from "../../../shared/lib/unconfirmed-write.js";
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
  { body: RunContactResearchRequest; idempotencyKey: string }
> {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: outreachKeys.researchTasks(tenantId),
    mutationFn: async ({ body, idempotencyKey }) => {
      const path = "/v1/contacts/research";
      const response = await http.json<ContactResearchStartResponse>("POST", path, { body, idempotencyKey });
      if (response?.ok !== true || !response.taskId || !response.runId || !response.workflowId || !response.status) {
        throw createUnconfirmedWriteError("POST", path, new TypeError("The research response did not confirm the queued task"));
      }
      return response;
    },
    onSettled: () => {
      void invalidateQueriesWithOptimisticOwnership(queryClient, outreachKeys.researchTaskLists(tenantId));
    },
  });
}
