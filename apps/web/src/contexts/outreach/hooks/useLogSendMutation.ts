import type { LogOutreachSendRequest, LogOutreachSendResponse, OutreachThreadResponse } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { useRef } from "react";

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
  const { api } = usePorts();
  const queryClient = useQueryClient();
  const attempted = useRef(new Set<string>());
  const threadForContactKey = outreachKeys.threadForContact(tenantId, contactId, jobId ?? null);
  return useMutation({
    mutationKey: outreachKeys.thread(tenantId, threadId),
    mutationFn: (body: LogSendVariables) => api.logOutreachSend(threadId, body),
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: threadForContactKey, exact: true });
      // A prior uncertain attempt may already be visible through a current read.
      // Until the receipt returns, only the server can identify that fact.
      if (!attempted.current.has(variables.requestId)) {
        attempted.current.add(variables.requestId);
        queryClient.setQueryData(threadForContactKey, (current: unknown) => markThreadSentInThread(current, variables, threadId));
      }
    },
    onSettled: (data, _error, variables) => {
      queryClient.setQueryData<OutreachThreadResponse>(threadForContactKey, (current) => {
        if (!current?.thread || current.thread.threadId !== threadId) return current;
        const logs = current.thread.sendLogs.filter((log) => log.sendLogId !== `optimistic-send:${variables.requestId}`);
        if (data && !logs.some((log) => log.sendLogId === data.sendLog.sendLogId)) logs.push(data.sendLog);
        return { ...current, thread: { ...current.thread, sendLogs: logs, isSent: logs.length > 0 } };
      });
      for (const queryKey of [threadForContactKey, outreachKeys.thread(tenantId, threadId), outreachKeys.threads(tenantId), outreachKeys.dueFollowUps(tenantId)]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}
