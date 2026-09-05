import type {
  ApplicationOutcomeWriteResponse,
  ApplyReviewDecisionRequest,
  ApplyReviewDecisionResponse,
  RepeatApplicationOverrideRequest,
  RepeatApplicationOverrideResponse,
  ManualApplicationOutcomeRequest,
  OutcomeSuggestionDecisionRequest,
  OutcomeSuggestionDecisionResponse,
  ResumeCommentReplyRequest,
  ResumeCommentReplyResponse,
  ResumeReviewCommentThreadSeedRequest,
  ResumeReviewCommentThreadSeedResponse,
  ResumeReviewDraftCreateRequest,
  ResumeReviewDraft,
  ResumeReviewDraftRenderRequest,
  ResumeReviewDraftRenderResponse,
  ResumeReviewDraftResponse,
  ResumeReviewDraftRevisionResponse,
  ResumeReviewDraftRevisionSaveRequest,
} from "@jobctrl/contracts";
import type { TenantId } from "@jobctrl/domain-types";
import {
  useMutation,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { applyReviewKeys } from "../../operations/applyReviewKeys.js";
import { artifactsKeys } from "../../operations/artifactsKeys.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import { outcomesKeys } from "../../operations/outcomesKeys.js";
import type { JobId } from "../../operations/types.js";
import { reconcileResumeReviewDraft, reconcileResumeReviewReply } from "./reconcileResumeReviewDraft.js";

export interface ApplyReviewDecisionVariables {
  readonly jobId: JobId;
  readonly body: ApplyReviewDecisionRequest;
}

export interface RepeatApplicationOverrideVariables {
  readonly jobId: JobId;
  readonly body: RepeatApplicationOverrideRequest;
}

export interface ManualApplicationOutcomeVariables {
  readonly jobId: JobId;
  readonly body: ManualApplicationOutcomeRequest;
}

export interface OutcomeSuggestionDecisionVariables {
  readonly suggestionId: string;
  readonly jobId?: JobId;
  readonly body: OutcomeSuggestionDecisionRequest;
}

export interface CreateResumeReviewDraftVariables {
  readonly jobId: JobId;
  readonly body?: ResumeReviewDraftCreateRequest;
}

export interface SaveResumeReviewDraftRevisionVariables {
  readonly jobId: JobId;
  readonly draftId: string;
  readonly body: ResumeReviewDraftRevisionSaveRequest;
}

export interface SeedResumeReviewCommentThreadsVariables {
  readonly jobId: JobId;
  readonly draftId: string;
  readonly body: ResumeReviewCommentThreadSeedRequest;
}

export interface RenderResumeReviewDraftVariables {
  readonly jobId: JobId;
  readonly draftId: string;
  readonly body?: ResumeReviewDraftRenderRequest;
}

export interface ReplyToResumeReviewCommentVariables {
  readonly jobId: JobId;
  readonly threadId: string;
  readonly body: ResumeCommentReplyRequest;
}

function invalidateApplyReviewSurfaces(
  queryClient: QueryClient,
  tenantId: TenantId,
  jobId?: JobId,
): void {
  void queryClient.invalidateQueries({ queryKey: jobsKeys.lists(tenantId) });
  void queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(tenantId) });
  void queryClient.invalidateQueries({ queryKey: applyReviewKeys.queue(tenantId) });
  void queryClient.invalidateQueries({ queryKey: outcomesKeys.list(tenantId) });
  if (jobId) {
    void queryClient.invalidateQueries({ queryKey: applyReviewKeys.draft(tenantId, jobId) });
    void queryClient.invalidateQueries({ queryKey: applyReviewKeys.feedback(tenantId, jobId) });
    void queryClient.invalidateQueries({ queryKey: jobsKeys.detail(tenantId, jobId) });
    void queryClient.invalidateQueries({ queryKey: outcomesKeys.detail(tenantId, jobId) });
  }
}

export function useApplyReviewDecisionMutation(): UseMutationResult<
  ApplyReviewDecisionResponse,
  Error,
  ApplyReviewDecisionVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ jobId, body }) => api.decideApplyReview(jobId, body),
    onSettled: (_data, _error, variables) => {
      invalidateApplyReviewSurfaces(queryClient, tenantId, variables.jobId);
    },
  });
}

export function useRepeatApplicationOverrideMutation(): UseMutationResult<
  RepeatApplicationOverrideResponse,
  Error,
  RepeatApplicationOverrideVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ jobId, body }) => api.confirmRepeatApplication(jobId, body),
    onSettled: (_data, _error, variables) => {
      invalidateApplyReviewSurfaces(queryClient, tenantId, variables.jobId);
    },
  });
}

export function useRecordManualApplicationOutcomeMutation(): UseMutationResult<
  ApplicationOutcomeWriteResponse,
  Error,
  ManualApplicationOutcomeVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ jobId, body }) => api.recordManualApplicationOutcome(jobId, body),
    onSettled: (_data, _error, variables) => {
      invalidateApplyReviewSurfaces(queryClient, tenantId, variables.jobId);
    },
  });
}

export function useOutcomeSuggestionDecisionMutation(): UseMutationResult<
  OutcomeSuggestionDecisionResponse,
  Error,
  OutcomeSuggestionDecisionVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ suggestionId, body }) => api.decideOutcomeSuggestion(suggestionId, body),
    onSettled: (_data, _error, variables) => {
      invalidateApplyReviewSurfaces(queryClient, tenantId, variables.jobId);
    },
  });
}

function publishDraft(queryClient: QueryClient, tenantId: TenantId, jobId: JobId, draft: ResumeReviewDraft): void {
  if (draft.jobKey !== jobId) return;
  queryClient.setQueryData<ResumeReviewDraftResponse>(applyReviewKeys.draft(tenantId, jobId), (current) => ({
    ok: true,
    draft: reconcileResumeReviewDraft(current?.draft, draft),
  }));
}

export function useCreateResumeReviewDraftMutation(): UseMutationResult<
  ResumeReviewDraftResponse,
  Error,
  CreateResumeReviewDraftVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    onMutate: () => ({ tenantId }),
    mutationFn: ({ jobId, body }) => api.createResumeReviewDraft(jobId, body ?? {}),
    onSuccess: (data, variables, context) => {
      const tenantId = context!.tenantId;
      publishDraft(queryClient, tenantId, variables.jobId, data.draft);
    },
    onSettled: (_data, _error, variables, context) => {
      const tenantId = context!.tenantId;
      invalidateApplyReviewSurfaces(queryClient, tenantId, variables.jobId);
    },
  });
}

export function useSaveResumeReviewDraftRevisionMutation(): UseMutationResult<
  ResumeReviewDraftRevisionResponse,
  Error,
  SaveResumeReviewDraftRevisionVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    onMutate: () => ({ tenantId }),
    mutationFn: ({ draftId, body }) => api.saveResumeReviewDraftRevision(draftId, body),
    onSuccess: (data, variables, context) => {
      const tenantId = context!.tenantId;
      publishDraft(queryClient, tenantId, variables.jobId, data.draft);
    },
    onSettled: (_data, _error, variables, context) => {
      const tenantId = context!.tenantId;
      invalidateApplyReviewSurfaces(queryClient, tenantId, variables.jobId);
    },
  });
}

export function useSeedResumeReviewCommentThreadsMutation(): UseMutationResult<
  ResumeReviewCommentThreadSeedResponse,
  Error,
  SeedResumeReviewCommentThreadsVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    onMutate: () => ({ tenantId }),
    mutationFn: ({ draftId, body }) => api.seedResumeReviewCommentThreads(draftId, body),
    onSuccess: (data, variables, context) => {
      const tenantId = context!.tenantId;
      publishDraft(queryClient, tenantId, variables.jobId, data.draft);
    },
    onSettled: (_data, _error, variables, context) => {
      const tenantId = context!.tenantId;
      invalidateApplyReviewSurfaces(queryClient, tenantId, variables.jobId);
    },
  });
}

export function useRenderResumeReviewDraftMutation(): UseMutationResult<
  ResumeReviewDraftRenderResponse,
  Error,
  RenderResumeReviewDraftVariables,
  { readonly tenantId: TenantId }
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    onMutate: () => ({ tenantId }),
    mutationFn: ({ draftId, body }) => api.renderResumeReviewDraft(draftId, body ?? {}),
    onSuccess: (data, variables, context) => {
      const tenantId = context!.tenantId;
      publishDraft(queryClient, tenantId, variables.jobId, data.draft);
      void queryClient.invalidateQueries({ queryKey: artifactsKeys.lists(tenantId) });
      if (data.ok) {
        void queryClient.invalidateQueries({
          queryKey: artifactsKeys.detail(tenantId, data.artifacts.resumeText.artifactId),
        });
        void queryClient.invalidateQueries({
          queryKey: artifactsKeys.detail(tenantId, data.artifacts.resumePdf.artifactId),
        });
      }
    },
    onSettled: (_data, _error, variables, context) => {
      const tenantId = context!.tenantId;
      invalidateApplyReviewSurfaces(queryClient, tenantId, variables.jobId);
    },
  });
}

export function useReplyToResumeReviewCommentMutation(): UseMutationResult<
  ResumeCommentReplyResponse,
  Error,
  ReplyToResumeReviewCommentVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    onMutate: () => ({ tenantId }),
    mutationFn: ({ threadId, body }) => api.replyToResumeReviewComment(threadId, body),
    onSuccess: (data, variables, context) => {
      queryClient.setQueryData<ResumeReviewDraftResponse>(
        applyReviewKeys.draft(context!.tenantId, variables.jobId),
        (current) => current ? { ...current, draft: reconcileResumeReviewReply(current.draft, data) } : current,
      );
    },
    onSettled: (_data, _error, variables, context) => {
      const tenantId = context!.tenantId;
      invalidateApplyReviewSurfaces(queryClient, tenantId, variables.jobId);
    },
  });
}
