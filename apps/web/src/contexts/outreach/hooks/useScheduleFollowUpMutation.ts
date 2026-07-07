import type { OutreachThreadResponse, ScheduleFollowUpRequest } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { setThreadFollowUpInThread } from "../lib/follow-up-patches.js";
import { outreachKeys } from "../queryKeys.js";

export type ScheduleFollowUpVariables = ScheduleFollowUpRequest;

/**
 * Schedule a surfaced-only follow-up reminder for the thread (a plan, never a
 * send — INV-1). Optimistically sets the cached by-contact thread's follow-up to
 * `scheduled`; the due-follow-ups list is invalidated on settle. Rolls back on
 * failure.
 */
export function useScheduleFollowUpMutation(
  threadId: string,
  contactId: string,
  jobId?: string,
): UseMutationResult<OutreachThreadResponse, Error, ScheduleFollowUpVariables> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  const threadForContactKey = outreachKeys.threadForContact(tenantId, contactId, jobId ?? null);
  return useMutation(
    createOptimisticMutation<OutreachThreadResponse, ScheduleFollowUpVariables>(queryClient, {
      mutationKey: outreachKeys.thread(tenantId, threadId),
      mutationFn: (body) => api.scheduleOutreachFollowUp(threadId, body),
      optimisticUpdates: (variables) => [
        {
          queryKey: threadForContactKey,
          patch: (current) =>
            setThreadFollowUpInThread(current, {
              state: "scheduled",
              dueAt: variables.dueAt ?? null,
              basis: variables.basis ?? "",
            }),
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
