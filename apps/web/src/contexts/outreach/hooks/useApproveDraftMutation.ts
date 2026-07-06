import type { OutreachThreadResponse } from "@jobhunter/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { approveDraftInThread } from "../lib/draft-patches.js";
import { outreachKeys } from "../queryKeys.js";

export interface ApproveDraftVariables {
  draftId: string;
}

/**
 * Approve a candidate draft. Optimistically flips the target candidate to
 * `approved` and supersedes the previously-approved draft in the cached
 * by-contact thread (INV-5 — one approved draft; the prior one is retained as
 * history). Rolls back on failure; the SSE invalidation reconciles authority.
 */
export function useApproveDraftMutation(
  threadId: string,
  contactId: string,
  jobId?: string,
): UseMutationResult<OutreachThreadResponse, Error, ApproveDraftVariables> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  const threadForContactKey = outreachKeys.threadForContact(tenantId, contactId, jobId ?? null);
  return useMutation(
    createOptimisticMutation<OutreachThreadResponse, ApproveDraftVariables>(queryClient, {
      mutationKey: outreachKeys.thread(tenantId, threadId),
      mutationFn: ({ draftId }) => api.approveOutreachDraft(threadId, draftId),
      optimisticUpdates: ({ draftId }) => [
        {
          queryKey: threadForContactKey,
          patch: (current) => approveDraftInThread(current, draftId),
        },
      ],
      settle: () => [threadForContactKey, outreachKeys.threads(tenantId)],
    }),
  );
}
