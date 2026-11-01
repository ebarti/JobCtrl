import type { ReviseOutreachDraftRequest, ReviseOutreachDraftResponse } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { createUnconfirmedWriteError } from "../../../shared/lib/unconfirmed-write.js";
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
): UseMutationResult<ReviseOutreachDraftResponse, Error, ReviseOutreachDraftRequest> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    retry: false,
    mutationKey: outreachKeys.thread(tenantId, threadId),
    mutationFn: async (body: ReviseOutreachDraftRequest) => {
      const response = await api.reviseOutreachDraft(threadId, body);
      // The HTTP schema applies JS trim, then the Python worker applies strip.
      // Python additionally strips Unicode whitespace and U+001C..U+001F.
      const submittedText = body.editedBodyText.trim()
        .replace(/^[\p{White_Space}\u001c-\u001f]+|[\p{White_Space}\u001c-\u001f]+$/gu, "");
      const publication = response?.publication;
      // The worker identifies the draft published by this request. A matching
      // historical body alone cannot acknowledge a new revision.
      if (!response || response.ok !== true || !response.thread || response.thread.threadId !== threadId
        || !publication || publication.threadId !== threadId
        || typeof publication.draftId !== "string" || !publication.draftId
        || !Number.isInteger(publication.generation) || publication.generation < 1
        || !Array.isArray(response.thread.drafts) || !response.thread.drafts.some((draft) =>
          draft && draft.draftId === publication.draftId
          && draft.threadId === publication.threadId && draft.generation === publication.generation
          && draft.bodyText === submittedText)) {
        throw createUnconfirmedWriteError(
          "POST", `/v1/outreach/threads/${encodeURIComponent(threadId)}/drafts`,
          new TypeError("Revision response did not acknowledge the submitted draft"),
        );
      }
      return response;
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: outreachKeys.threadForContact(tenantId, contactId, jobId ?? null),
      });
      void queryClient.invalidateQueries({ queryKey: outreachKeys.threads(tenantId) });
    },
  });
}
