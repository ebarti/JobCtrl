import { JobCtrlApiError } from "@jobctrl/api-client";
import { InterviewQuestionNoteSchema, type InterviewNotesResponse, type SaveInterviewQuestionNoteRequest, type SaveInterviewQuestionNoteResponse } from "../../operations/types.js";
import { z } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { interviewKeys } from "../../operations/interviewKeys.js";
import { interviewDraftKey, useInterviewDraftStore } from "../stores/interview-drafts.js";

interface SaveNoteVariables { readonly body: SaveInterviewQuestionNoteRequest; readonly editVersion: number }
type PendingResponse = InterviewNotesResponse & { pendingEditVersion?: number };

export function useSaveInterviewNoteMutation(jobId: string, questionId: string) {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  const key = interviewKeys.note(tenantId, jobId, questionId);
  const draftKey = interviewDraftKey(tenantId, jobId, questionId);
  const options = createOptimisticMutation<SaveInterviewQuestionNoteResponse, SaveNoteVariables>(queryClient, {
    mutationFn: ({ body }) => api.saveInterviewNote(jobId, body),
    optimisticUpdates: ({ body, editVersion }) => [{
      queryKey: key,
      patch: (previous) => {
        const current = previous as PendingResponse | undefined;
        if (!current) return previous;
        return { ...current, pendingEditVersion: editVersion, notes: [{
          jobId, questionId, revision: body.expectedRevision + 1, noteText: body.noteText,
          factualSupport: body.factualSupport ?? "unverified_user_statement", editStatus: "user_edited",
          sourceGeneration: body.sourceGeneration ?? null, bindings: body.bindings ?? null,
          updatedAt: current.notes[0]?.updatedAt ?? "",
        }] } satisfies PendingResponse;
      },
    }],
    settle: () => [interviewKeys.note(tenantId, jobId, questionId)],
    meta: { suppressGlobalErrorToast: true },
  });
  return useMutation({
    ...options,
    scope: { id: draftKey },
    onError: (error, variables, context, mutationContext) => {
      // A terminal SSE/refetch or a newer save may already have replaced the
      // optimistic row. An old failure must never restore an old cache snapshot.
      const current = queryClient.getQueryData<PendingResponse>(key);
      if (current?.pendingEditVersion === variables.editVersion) {
        options.onError?.(error, variables, context, mutationContext);
      }
      if (error instanceof JobCtrlApiError && error.status === 409) {
        const conflict = z.object({ currentNote: InterviewQuestionNoteSchema.nullable() }).safeParse(error.responseBody);
        const note = conflict.success ? conflict.data.currentNote : null;
        const canonical = queryClient.getQueryData<PendingResponse>(key);
        const savedRevision = canonical && !canonical.pendingEditVersion ? canonical.notes[0]?.revision ?? 0 : 0;
        useInterviewDraftStore.getState().conflictNote(draftKey, Math.max(savedRevision, note?.revision ?? variables.body.expectedRevision + 1));
        if (note && savedRevision <= note.revision) queryClient.setQueryData<PendingResponse>(key, { ok: true, jobId, notes: [note], page: 1, pageSize: 20, total: 1 });
      }
    },
    onSuccess: ({ note }, variables) => {
      useInterviewDraftStore.getState().acknowledgeNote(draftKey, variables.editVersion, note.revision);
      queryClient.setQueryData<PendingResponse>(key, (current) => {
        if (current && !current.pendingEditVersion && (current.notes[0]?.revision ?? 0) > note.revision) return current;
        return { ok: true, jobId, notes: [note], page: 1, pageSize: 20, total: 1 };
      });
    },
  });
}
