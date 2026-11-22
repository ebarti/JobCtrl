import type { LogOutreachSendRequest, LogOutreachSendResponse, OutreachThreadResponse } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { useRef } from "react";

import { applyPartialQueryPatch, createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { createUnconfirmedWriteError } from "../../../shared/lib/unconfirmed-write.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { markThreadSentInThread } from "../lib/follow-up-patches.js";
import { outreachKeys } from "../queryKeys.js";

export type LogSendVariables = LogOutreachSendRequest;

/** Reconcile only this fact; never install a historical thread snapshot. */
export function useLogSendMutation(
  threadId: string,
  contactId: string,
  jobId?: string,
): UseMutationResult<LogOutreachSendResponse, Error, LogSendVariables> {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const queryClient = useQueryClient();
  const attempted = useRef(new Set<string>());
  const threadForContactKey = outreachKeys.threadForContact(tenantId, contactId, jobId ?? null);
  const options = createOptimisticMutation<LogOutreachSendResponse, LogSendVariables>(queryClient, {
    mutationKey: outreachKeys.thread(tenantId, threadId),
    mutationFn: async (body) => {
      const path = `/v1/outreach/threads/${encodeURIComponent(threadId)}/send-logs`;
      const response = await http.json<LogOutreachSendResponse>("POST", path, { body });
      const log = response?.sendLog;
      if (response?.ok !== true || !log || !log.sendLogId || log.threadId !== threadId || log.draftId !== body.draftId || log.channel !== body.channel || log.sentAt !== body.sentAt) {
        throw createUnconfirmedWriteError("POST", path, new TypeError("The send attestation response did not confirm the submitted facts"));
      }
      return response;
    },
    optimisticUpdates: (variables) => {
      // A prior uncertain attempt may already be visible through a current read.
      // Until the receipt returns, only the server can identify that fact.
      const firstAttempt = !attempted.current.has(variables.requestId);
      attempted.current.add(variables.requestId);
      return [{
        queryKey: threadForContactKey,
        patch: (current) => firstAttempt ? markThreadSentInThread(current, variables, threadId) : current,
      }];
    },
    settle: () => [threadForContactKey, outreachKeys.thread(tenantId, threadId), outreachKeys.threads(tenantId), outreachKeys.dueFollowUps(tenantId)],
  });
  return useMutation({
    ...options,
    onSettled: (data, error, variables, mutationResult, context) => {
      const query = queryClient.getQueryCache().find({ queryKey: threadForContactKey, exact: true });
      if (query) applyPartialQueryPatch(queryClient, query, (current) => {
        const read = current as OutreachThreadResponse | undefined;
        if (!read?.thread || read.thread.threadId !== threadId) return current;
        const logs = read.thread.sendLogs.filter((log) => log.sendLogId !== `optimistic-send:${variables.requestId}`);
        if (data && !logs.some((log) => log.sendLogId === data.sendLog.sendLogId)) logs.push(data.sendLog);
        return { ...read, thread: { ...read.thread, sendLogs: logs, isSent: logs.length > 0 } };
      });
      return options.onSettled?.(data, error, variables, mutationResult, context);
    },
  });
}
