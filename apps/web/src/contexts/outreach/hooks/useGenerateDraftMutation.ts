import type { GenerateOutreachDraftRequest, ReviseOutreachDraftResponse } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { invalidateQueriesWithOptimisticOwnership } from "../../../shared/lib/createOptimisticMutation.js";
import { createUnconfirmedWriteError } from "../../../shared/lib/unconfirmed-write.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { outreachKeys } from "../queryKeys.js";
import { requireThreadFingerprint, type ThreadDetail } from "../contracts.js";

/**
 * Generate a new outreach draft for a contact. Plain `useMutation` (not
 * `createOptimisticMutation`) by design: the server writes the draft body, runs
 * the reused truthfulness gate stack (deterministic fabrication + validation +
 * judge) and returns the full gated thread — there is no meaningful client-side
 * body to patch optimistically (the documented exception to CLAUDE.md's
 * optimistic-mutation rule). INV-5: a fresh candidate joins the generation
 * history and never removes the last approved draft.
 */
export type GenerateDraftVariables = GenerateOutreachDraftRequest & { expectedFingerprint: string | null };
export type GeneratedDraftResponse = Omit<ReviseOutreachDraftResponse, "thread"> & { thread: ThreadDetail };

export function useGenerateDraftMutation(
  contactId: string,
): UseMutationResult<GeneratedDraftResponse, Error, GenerateDraftVariables> {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    retry: false,
    mutationKey: outreachKeys.threads(tenantId),
    mutationFn: async (body: GenerateDraftVariables) => {
      const path = `/v1/contacts/${encodeURIComponent(contactId)}/outreach/drafts`;
      const response = await http.json<ReviseOutreachDraftResponse>("POST", path, { body });
      let thread: ThreadDetail | null;
      try { thread = requireThreadFingerprint(response).thread; }
      catch (error) { throw createUnconfirmedWriteError("POST", path, error); }
      const publication = response?.publication;
      if (!thread || thread.contactId !== contactId || thread.jobId !== (body.jobId ?? null) ||
          !publication || publication.threadId !== thread.threadId || typeof publication.draftId !== "string" || !publication.draftId ||
          !Number.isInteger(publication.generation) || publication.generation < 1 ||
          !Array.isArray(thread.drafts) ||
          !thread.drafts.some((draft) => draft.draftId === publication.draftId && draft.threadId === thread!.threadId &&
            draft.generation === publication.generation && (!body.kind || draft.kind === body.kind))) {
        throw createUnconfirmedWriteError("POST", path, new TypeError("The generation response did not confirm the published draft"));
      }
      return { ...response, thread };
    },
    onSettled: (_data, _error, variables) => {
      void invalidateQueriesWithOptimisticOwnership(queryClient, outreachKeys.threadForContact(tenantId, contactId, variables.jobId ?? null));
      void invalidateQueriesWithOptimisticOwnership(queryClient, outreachKeys.threads(tenantId));
    },
  });
}
