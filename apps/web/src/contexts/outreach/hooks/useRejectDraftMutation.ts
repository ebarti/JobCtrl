import type { OutreachThreadResponse, RejectOutreachDraftRequest } from "@jobhunter/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { rejectDraftInThread } from "../lib/draft-patches.js";
import { outreachKeys } from "../queryKeys.js";

export interface RejectDraftVariables extends RejectOutreachDraftRequest {
  draftId: string;
}

/**
 * Reject a candidate draft. Optimistically flips the target candidate to
 * `rejected` and LEAVES any approved draft untouched (INV-5 — rejecting a
 * re-draft never removes the last approved message). Rolls back on failure.
 */
export function useRejectDraftMutation(
  threadId: string,
  contactId: string,
  jobId?: string,
): UseMutationResult<OutreachThreadResponse, Error, RejectDraftVariables> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  const threadForContactKey = outreachKeys.threadForContact(tenantId, contactId, jobId ?? null);
  return useMutation(
    createOptimisticMutation<OutreachThreadResponse, RejectDraftVariables>(queryClient, {
      mutationKey: outreachKeys.thread(tenantId, threadId),
      mutationFn: ({ draftId, ...body }) => api.rejectOutreachDraft(threadId, draftId, body),
      optimisticUpdates: ({ draftId }) => [
        {
          queryKey: threadForContactKey,
          patch: (current) => rejectDraftInThread(current, draftId),
        },
      ],
      settle: () => [threadForContactKey, outreachKeys.threads(tenantId)],
    }),
  );
}
