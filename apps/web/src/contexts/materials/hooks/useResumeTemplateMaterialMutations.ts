import type {
  EnsureCurrentResumeMaterialsRequest,
  EnsureCurrentResumeMaterialsResponse,
  JobResumeTemplateAssignmentRequest,
  JobResumeTemplateAssignmentResponse,
} from "@jobhunter/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

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
