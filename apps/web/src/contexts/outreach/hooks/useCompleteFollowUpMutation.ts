import type { OutreachThreadResponse } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { currentFollowUpOf, setThreadFollowUpInThread } from "../lib/follow-up-patches.js";
import { outreachKeys } from "../queryKeys.js";

/**
 * Mark the thread's scheduled follow-up as completed. Optimistically flips the
 * cached follow-up state to `completed` while preserving its prior dueAt/basis;
 * the due-follow-ups list is invalidated on settle. Rolls back on failure. A
 * follow-up is a surfaced-only reminder — nothing is sent (INV-1).
 */
export function useCompleteFollowUpMutation(
  threadId: string,
  contactId: string,
  jobId?: string,
): UseMutationResult<OutreachThreadResponse, Error, { expectedFingerprint: string }> {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const queryClient = useQueryClient();
  const threadForContactKey = outreachKeys.threadForContact(tenantId, contactId, jobId ?? null);
  return useMutation(
    createOptimisticMutation<OutreachThreadResponse, { expectedFingerprint: string }>(queryClient, {
      mutationKey: outreachKeys.thread(tenantId, threadId),
      mutationFn: (body) => http.json<OutreachThreadResponse>(
        "POST", `/v1/outreach/threads/${encodeURIComponent(threadId)}/follow-up/complete`, { body },
      ),
      optimisticUpdates: () => [
        {
          queryKey: threadForContactKey,
          patch: (current) => {
            const prior = currentFollowUpOf(current);
            return setThreadFollowUpInThread(current, {
              ...(prior ?? { dueAt: null, basis: "" }),
              state: "completed",
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
