import type {
  ConfirmContactCandidateRequest,
  ConfirmContactCandidateResponse,
} from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { markCandidateConfirmed } from "../lib/research-patches.js";
import { outreachKeys } from "../queryKeys.js";

export interface ConfirmCandidateVariables extends ConfirmContactCandidateRequest {
  candidateId: string;
}

/**
 * Confirm a proposed candidate into a stored Contact fact (INV-4). Optimistically
 * flips the candidate to `confirmed` in the cached task detail; rolls back if the
 * POST fails, and the SSE invalidation reconciles the authoritative state.
 */
export function useConfirmCandidateMutation(
  taskId: string,
): UseMutationResult<ConfirmContactCandidateResponse, Error, ConfirmCandidateVariables> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<ConfirmContactCandidateResponse, ConfirmCandidateVariables>(
      queryClient,
      {
        mutationKey: outreachKeys.researchTask(tenantId, taskId),
        mutationFn: ({ candidateId, ...body }) =>
          api.confirmContactCandidate(taskId, candidateId, body),
        optimisticUpdates: ({ candidateId }) => [
          {
            queryKey: outreachKeys.researchTask(tenantId, taskId),
            patch: (current) => markCandidateConfirmed(current, candidateId),
          },
        ],
        settle: () => [
          outreachKeys.researchTask(tenantId, taskId),
          outreachKeys.researchTaskLists(tenantId),
          outreachKeys.contactLists(tenantId),
        ],
      },
    ),
  );
}
