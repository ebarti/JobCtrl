import type { OutreachThreadResponse } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { currentFollowUpOf, setThreadFollowUpInThread } from "../lib/follow-up-patches.js";
import { outreachKeys } from "../queryKeys.js";

/**
 * Dismiss the thread's scheduled follow-up. Optimistically flips the cached
 * follow-up state to `dismissed` while preserving its prior dueAt/basis; the
 * due-follow-ups list is invalidated on settle. Rolls back on failure. A
 * follow-up is a surfaced-only reminder — nothing is sent (INV-1).
 */
export function useDismissFollowUpMutation(
  threadId: string,
  contactId: string,
  jobId?: string,
): UseMutationResult<OutreachThreadResponse, Error, void> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  const threadForContactKey = outreachKeys.threadForContact(tenantId, contactId, jobId ?? null);
  return useMutation(
    createOptimisticMutation<OutreachThreadResponse, void>(queryClient, {
      mutationKey: outreachKeys.thread(tenantId, threadId),
      mutationFn: () => api.dismissOutreachFollowUp(threadId),
      optimisticUpdates: () => [
        {
          queryKey: threadForContactKey,
          patch: (current) => {
            const prior = currentFollowUpOf(current);
            return setThreadFollowUpInThread(current, {
              ...(prior ?? { dueAt: null, basis: "" }),
              state: "dismissed",
            });
          },
        },
      ],
      settle: () => [
        threadForContactKey,
        outreachKeys.threads(tenantId),
        outreachKeys.dueFollowUps(tenantId),
      ],
    }),
  );
}
