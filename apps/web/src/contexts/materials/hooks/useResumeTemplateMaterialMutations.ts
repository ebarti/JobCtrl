import type {
  EnsureCurrentResumeMaterialsRequest,
  EnsureCurrentResumeMaterialsResponse,
  JobResumeTemplateAssignmentRequest,
  JobResumeTemplateAssignmentResponse,
} from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import type { ApiClientPort } from "../../../shared/ports/ApiClientPort.js";
export type LocaleHistory = Awaited<ReturnType<ApiClientPort["localeVariants"]>>;
export type LocaleVariant = LocaleHistory["variants"][number];
import { materialsKeys } from "../queryKeys.js";

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

export function useLocaleVariants(jobKey: string) {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  const key = materialsKeys.locales(tenantId, jobKey);
  const query = useQuery({ queryKey: key, queryFn: () => api.localeVariants(jobKey), enabled: typeof api.localeVariants === "function" });
  const generate = useMutation({
    mutationFn: (body: Parameters<ApiClientPort["generateLocaleVariant"]>[1]) => api.generateLocaleVariant(jobKey, body),
    onSuccess: (data) => queryClient.setQueryData(key, data),
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: key }); },
  });
  const review = useMutation({
    mutationFn: (body: Parameters<ApiClientPort["reviewLocaleVariant"]>[1]) => api.reviewLocaleVariant(jobKey, body),
    onMutate: async (body) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<LocaleHistory>(key);
      if (previous) queryClient.setQueryData<LocaleHistory>(key, { ...previous, variants: previous.variants.map((variant) => variant.variantId === body.variantId ? { ...variant, eligible: false } : variant) });
      return { previous };
    },
    onError: (_error, _body, context) => { if (context?.previous) queryClient.setQueryData(key, context.previous); },
    onSuccess: (data) => queryClient.setQueryData(key, data),
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: key }); },
  });
  return { query, generate, review };
}
