import type { LogOutreachSendRequest, OutreachThreadResponse } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { markThreadSentInThread } from "../lib/follow-up-patches.js";
import { outreachKeys } from "../queryKeys.js";

export type LogSendVariables = LogOutreachSendRequest;

/**
 * Record a user-attested send of an approved draft (INV-1 — JobCtrl never
 * sends; this logs a fact). Optimistically appends the send log and flips the
 * cached by-contact thread to `isSent`; the due-follow-ups list is invalidated on
 * settle because logging a send can seed a follow-up. Rolls back on failure.
 */
export function useLogSendMutation(
  threadId: string,
  contactId: string,
  jobId?: string,
): UseMutationResult<OutreachThreadResponse, Error, LogSendVariables> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  const threadForContactKey = outreachKeys.threadForContact(tenantId, contactId, jobId ?? null);
  return useMutation(
    createOptimisticMutation<OutreachThreadResponse, LogSendVariables>(queryClient, {
      mutationKey: outreachKeys.thread(tenantId, threadId),
      mutationFn: (body) => api.logOutreachSend(threadId, body),
      optimisticUpdates: (variables) => [
        {
          queryKey: threadForContactKey,
          patch: (current) => markThreadSentInThread(current, variables),
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
