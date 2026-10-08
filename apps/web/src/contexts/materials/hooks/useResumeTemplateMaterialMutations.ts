import type {
  EnsureCurrentResumeMaterialsRequest,
  EnsureCurrentResumeMaterialsResponse,
  JobResumeTemplateAssignmentRequest,
  JobResumeTemplateAssignmentResponse,
} from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import type { ApiClientPort } from "../../../shared/ports/ApiClientPort.js";
import type { JobDetail } from "../../operations/types.js";
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

// Locale writes are fenced separately from source generation and Apply approval.
export type MaterialLocaleMutation = Parameters<ApiClientPort["mutateMaterialLocaleVariants"]>[1];
export type MaterialLocaleState = NonNullable<JobDetail["localeVariants"]>;
export function useMaterialLocaleVariantMutation() {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ["tenant", tenantId, "materials", "locale-variants"],
    mutationFn: ({ jobId, body }: { jobId: string; body: MaterialLocaleMutation }) => api.mutateMaterialLocaleVariants(jobId, body),
    onMutate: async ({ jobId, body }) => {
      const key = jobsKeys.detail(tenantId, jobId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<LocaleJobDetail>(key);
      const token = {};
      queryClient.setQueryData<LocaleJobDetail>(key, (current) => {
        if (!current) return current;
        const state = current.localeVariants;
        if (!state || state.revision !== body.expected_revision || body.operation !== "review") return { ...current, localePending: token };
        return { ...current, localePending: token, localeVariants: {
          ...state,
          variants: state.variants.map((variant) => variant.variant_id === body.variant_id && variant.revision === body.expected_variant_revision
            ? { ...variant, [body.review_kind + "_review"]: body.decision } : variant),
        } };
      });
      return { previous, token };
    },
    onError: (_error, { jobId }, context) => {
      queryClient.setQueryData<LocaleJobDetail>(jobsKeys.detail(tenantId, jobId), (current) => {
        if (!current || !context || current.localePending !== context.token) return current;
        return { ...current, localeVariants: context.previous?.localeVariants ?? { revision: 0, variants: [], failures: [] }, localePending: undefined };
      });
    },
    onSuccess: (result: MaterialLocaleState, { jobId }, context) => {
      queryClient.setQueryData<LocaleJobDetail>(jobsKeys.detail(tenantId, jobId), (current) => {
        if (!current || (current.localeVariants?.revision ?? 0) > result.revision) return current;
        if (context && current.localePending !== context.token
          && (current.localeVariants?.revision ?? 0) >= result.revision) return current;
        // A canonical reload/source replacement during the request takes precedence.
        if (context?.previous && sourceSignature(current) !== sourceSignature(context.previous)) return current;
        return { ...current, localeVariants: result, localePending: undefined };
      });
    },
    onSettled: (_data, _error, { jobId }) => {
      void queryClient.invalidateQueries({ queryKey: jobsKeys.detail(tenantId, jobId) });
      void queryClient.invalidateQueries({ queryKey: applyReviewKeys.all(tenantId) });
    },
  });
}

type LocaleJobDetail = JobDetail & { localePending?: object | undefined };
function sourceSignature(detail: JobDetail): string {
  return detail.artifacts.map((artifact) => `${artifact.artifactId}:${artifact.status}`).join("|");
}
