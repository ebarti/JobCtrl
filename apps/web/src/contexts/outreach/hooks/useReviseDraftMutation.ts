import type { OutreachThreadResponse, ReviseOutreachDraftRequest } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { outreachKeys } from "../queryKeys.js";

/**
 * Revise a thread's draft from user-edited body text. Plain `useMutation`: the
 * server re-runs the full gate stack against the edited text and returns the new
 * gated candidate, so there is no meaningful optimistic body to patch. INV-5:
 * prior generations (including any approved draft) remain in the history.
 */
export function useReviseDraftMutation(
  threadId: string,
  contactId: string,
  jobId?: string,
): UseMutationResult<OutreachThreadResponse, Error, ReviseOutreachDraftRequest> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: outreachKeys.thread(tenantId, threadId),
    mutationFn: (body: ReviseOutreachDraftRequest) => api.reviseOutreachDraft(threadId, body),
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: outreachKeys.threadForContact(tenantId, contactId, jobId ?? null),
      });
      void queryClient.invalidateQueries({ queryKey: outreachKeys.threads(tenantId) });
    },
  });
}
