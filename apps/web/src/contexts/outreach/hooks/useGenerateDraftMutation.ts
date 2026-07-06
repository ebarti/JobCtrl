import type { GenerateOutreachDraftRequest, OutreachThreadResponse } from "@jobhunter/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { outreachKeys } from "../queryKeys.js";

/**
 * Generate a new outreach draft for a contact. Plain `useMutation` (not
 * `createOptimisticMutation`) by design: the server writes the draft body, runs
 * the reused truthfulness gate stack (deterministic fabrication + validation +
 * judge) and returns the full gated thread — there is no meaningful client-side
 * body to patch optimistically (the documented exception to CLAUDE.md's
 * optimistic-mutation rule). INV-5: a fresh candidate joins the generation
 * history and never removes the last approved draft.
 */
export function useGenerateDraftMutation(
  contactId: string,
): UseMutationResult<OutreachThreadResponse, Error, GenerateOutreachDraftRequest> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: outreachKeys.threads(tenantId),
    mutationFn: (body: GenerateOutreachDraftRequest) => api.generateOutreachDraft(contactId, body),
    onSettled: (_data, _error, variables) => {
      void queryClient.invalidateQueries({
        queryKey: outreachKeys.threadForContact(tenantId, contactId, variables.jobId ?? null),
      });
      void queryClient.invalidateQueries({ queryKey: outreachKeys.threads(tenantId) });
    },
  });
}
