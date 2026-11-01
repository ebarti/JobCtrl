import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { materialsKeys } from "../queryKeys.js";
import type {
  EnsureCurrentResumeMaterialsRequest,
  EnsureCurrentResumeMaterialsResponse,
  JobResumeTemplateAssignmentRequest,
  JobResumeTemplateAssignmentResponse,
} from "@jobctrl/contracts";
import { useQuery, useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { applyReviewKeys } from "../../operations/applyReviewKeys.js";
import { artifactsKeys } from "../../operations/artifactsKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";

export function useSetJobResumeTemplateMutation(): UseMutationResult<
  JobResumeTemplateAssignmentResponse,
  Error,
  { jobKey: string; body: JobResumeTemplateAssignmentRequest }
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ["tenant", tenantId, "materials", "resume-template-assignment"],
    mutationFn: ({ jobKey, body }) => api.setJobResumeTemplate(jobKey, body),
    onSettled: (_data, _error, variables) => {
      void queryClient.invalidateQueries({ queryKey: jobsKeys.detail(tenantId, variables.jobKey) });
      void queryClient.invalidateQueries({ queryKey: jobsKeys.lists(tenantId) });
      void queryClient.invalidateQueries({ queryKey: artifactsKeys.lists(tenantId) });
      void queryClient.invalidateQueries({ queryKey: applyReviewKeys.all(tenantId) });
    },
  });
}

export function useEnsureCurrentResumeMaterialsMutation(): UseMutationResult<
  EnsureCurrentResumeMaterialsResponse,
  Error,
  { jobKey: string; body?: Partial<EnsureCurrentResumeMaterialsRequest> }
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ["tenant", tenantId, "materials", "ensure-current-resume"],
    mutationFn: ({ jobKey, body = {} }) => api.ensureCurrentResumeMaterials(jobKey, body),
    onSettled: (_data, _error, variables) => {
      void queryClient.invalidateQueries({ queryKey: jobsKeys.detail(tenantId, variables.jobKey) });
      void queryClient.invalidateQueries({ queryKey: jobsKeys.lists(tenantId) });
      void queryClient.invalidateQueries({ queryKey: artifactsKeys.lists(tenantId) });
      void queryClient.invalidateQueries({ queryKey: applyReviewKeys.all(tenantId) });
    },
  });
}

// Screening reads share the Job Detail prefix so existing source-change SSE
// invalidations also fence this private view. No answers enter the Job projection.
export function useScreeningAnswers(jobId: string) {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: materialsKeys.screening(tenantId, jobId),
    queryFn: () => api.screeningAnswers(jobId),
    meta: { suppressGlobalErrorToast: true },
  });
}

export function useScreeningAnswerMutation(jobId: string) {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const client = useQueryClient();
  const key = materialsKeys.screening(tenantId, jobId);
  type Command = Parameters<typeof api.writeScreeningAnswer>[1];
  type Result = Awaited<ReturnType<typeof api.writeScreeningAnswer>>;
  type Read = Awaited<ReturnType<typeof api.screeningAnswers>>;
  type PendingRead = Read & { pendingScreeningKey?: string };
  const options = createOptimisticMutation<Result, Command>(client, {
      mutationFn: (body) => api.writeScreeningAnswer(jobId, body),
      optimisticUpdates: (body) => [{ queryKey: key, patch: (previous) => {
        const read = previous as PendingRead | undefined;
        if (!read || body.action !== "capture" || !body.questionId) return previous;
        // Only authored question edits are optimistic; authority is never fabricated.
        return { ...read, pendingScreeningKey: body.idempotencyKey, questions: read.questions.map((question) => question.questionId === body.questionId ? { ...question, question: body.question ?? question.question, context: body.context ?? question.context } : question) };
      } }],
      settle: () => [key], meta: { suppressGlobalErrorToast: true },
    });
  return useMutation({
    ...options,
    scope: { id: `screening:${tenantId}:${jobId}` },
    onError: (error, variables, context, mutationContext) => {
      if (client.getQueryData<PendingRead>(key)?.pendingScreeningKey === variables.idempotencyKey) options.onError?.(error, variables, context, mutationContext);
    },
    onSuccess: ({ state }) => {
      client.setQueryData<PendingRead>(key, (read) => {
        if (!read || (read.questions.find((row) => row.questionId === state.questionId)?.revision ?? 0) > state.revision) return read;
        const { pendingScreeningKey: _pending, ...canonical } = read;
        return { ...canonical, questions: [...read.questions.filter((row) => row.questionId !== state.questionId), state] };
      });
    },
  });
}

export function useScreeningCopyValidation(jobId: string) {
  const { api } = usePorts();
  const tenantId = useTenantId();
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ questionId, answerId }: { questionId: string; answerId: string }) => {
      const current = await api.screeningAnswers(jobId);
      type Read = Awaited<ReturnType<typeof api.screeningAnswers>>;
      const cached = client.getQueryData<Read>(materialsKeys.screening(tenantId, jobId));
      if ((cached?.questions.find((question) => question.questionId === questionId)?.revision ?? 0) > (current.questions.find((question) => question.questionId === questionId)?.revision ?? 0)) throw new Error("Screening answer changed; reload before copying.");
      client.setQueryData(materialsKeys.screening(tenantId, jobId), current);
      const answer = current.questions.find((question) => question.questionId === questionId)?.accepted;
      if (!answer || answer.answerId !== answerId || answer.staleReason) throw new Error("Screening answer changed; verify and review before copying.");
      return answer.text;
    },
    meta: { suppressGlobalErrorToast: true },
  });
}
