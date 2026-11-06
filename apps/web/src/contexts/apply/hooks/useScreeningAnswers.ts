import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createUnconfirmedWriteError,
  isUnconfirmedWrite,
} from "../../../shared/lib/unconfirmed-write.js";
import type { HttpPort } from "../../../shared/ports/HttpPort.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import {
  screeningReadSchema,
  screeningResponseSchema,
  type ScreeningCommand,
  type ScreeningRead,
} from "../contracts.js";
import { applyKeys } from "../queryKeys.js";
import {
  applicationDraftKey,
  useApplicationDraftStore,
  useScreeningDraftStore,
} from "../stores/review-drafts.js";

async function readScreening(http: HttpPort, jobId: string) {
  const parsed = screeningReadSchema.safeParse(
    await http.json<unknown>(
      "GET",
      `/v1/jobs/${encodeURIComponent(jobId)}/screening-answers`,
    ),
  );
  if (!parsed.success || parsed.data.jobId !== jobId)
    throw new Error(
      "The screening history response is invalid. Accepted answers remain unchanged.",
    );
  return parsed.data;
}

export function useScreeningAnswers(jobId: string) {
  const { http } = usePorts();
  const tenant = useTenantId();
  return useQuery({
    queryKey: applyKeys.screening(tenant, jobId),
    queryFn: () => readScreening(http, jobId),
    meta: { suppressGlobalErrorToast: true },
  });
}

export function useScreeningAnswerMutation(jobId: string) {
  const { http } = usePorts();
  const tenant = useTenantId();
  const client = useQueryClient();
  const draftKey = applicationDraftKey(tenant, jobId);
  const key = applyKeys.screening(tenant, jobId);
  const uncertain = useApplicationDraftStore(
    (state) => state.screeningUncertain[draftKey],
  );
  const mutation = useMutation({
    scope: { id: `screening:${draftKey}` },
    mutationFn: async (command: ScreeningCommand) => {
      const unresolved =
        useApplicationDraftStore.getState().screeningUncertain[draftKey];
      if (unresolved && JSON.stringify(unresolved) !== JSON.stringify(command))
        throw new Error(
          "Reconcile the unconfirmed screening request before saving another change.",
        );
      const path = `/v1/jobs/${encodeURIComponent(jobId)}/screening-answers`;
      try {
        const parsed = screeningResponseSchema.safeParse(
          await http.json<unknown>("POST", path, {
            body: command,
            idempotencyKey: command.idempotencyKey,
          }),
        );
        if (
          !parsed.success ||
          parsed.data.jobId !== jobId ||
          parsed.data.state.jobId !== jobId
        )
          throw createUnconfirmedWriteError(
            "POST",
            path,
            new Error("The saved screening response is invalid."),
          );
        return parsed.data;
      } catch (error) {
        if (unresolved && !isUnconfirmedWrite(error))
          useApplicationDraftStore
            .getState()
            .setScreeningUncertain(draftKey, undefined);
        throw error;
      }
    },
    onSuccess: ({ state }, command) => {
      useApplicationDraftStore
        .getState()
        .setScreeningUncertain(draftKey, undefined);
      const editKey = JSON.stringify([
        tenant,
        jobId,
        "screening",
        state.questionId,
      ]);
      useScreeningDraftStore
        .getState()
        .acknowledge(
          [editKey, editKey + ":question", editKey + ":context"],
          command.expectedRevision,
          state.revision,
        );
      client.setQueryData<ScreeningRead>(key, (read) => {
        if (
          !read ||
          (read.questions.find(
            (question) => question.questionId === state.questionId,
          )?.revision ?? 0) > state.revision
        )
          return read;
        return {
          ...read,
          questions: [
            ...read.questions.filter(
              (question) => question.questionId !== state.questionId,
            ),
            state,
          ],
        };
      });
    },
    onError: (error, command) => {
      if (isUnconfirmedWrite(error))
        useApplicationDraftStore
          .getState()
          .setScreeningUncertain(draftKey, command);
    },
    onSettled: () => {
      void client.invalidateQueries({
        queryKey: applyKeys.application(tenant, jobId),
      });
      void client.invalidateQueries({ queryKey: applyKeys.queue(tenant) });
    },
    meta: { suppressGlobalErrorToast: true },
  });
  return { ...mutation, uncertain };
}

export function useScreeningCopyValidation(jobId: string) {
  const { http } = usePorts();
  const tenant = useTenantId();
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      questionId,
      answerId,
    }: {
      questionId: string;
      answerId: string;
    }) => {
      const current = await readScreening(http, jobId);
      const key = applyKeys.screening(tenant, jobId);
      const cached = client.getQueryData<ScreeningRead>(key);
      if (
        (cached?.questions.find(
          (question) => question.questionId === questionId,
        )?.revision ?? 0) >
        (current.questions.find(
          (question) => question.questionId === questionId,
        )?.revision ?? 0)
      )
        throw new Error("The answer changed. Reload before copying.");
      client.setQueryData(key, current);
      const accepted = current.questions.find(
        (question) => question.questionId === questionId,
      )?.accepted;
      if (!accepted || accepted.answerId !== answerId || accepted.staleReason)
        throw new Error(
          "The answer changed. Verify and review it before copying.",
        );
      return accepted.text;
    },
    meta: { suppressGlobalErrorToast: true },
  });
}
