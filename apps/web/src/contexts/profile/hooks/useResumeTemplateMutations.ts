import type {
  ResumeTemplateDefaultSelectionRequest,
  ResumeTemplateDefaultSelectionResponse,
  ResumeTemplateVersionSaveRequest,
  ResumeTemplateVersionSaveResponse,
} from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { profileKeys } from "../queryKeys.js";

export function useSaveResumeTemplateMutation(): UseMutationResult<
  ResumeTemplateVersionSaveResponse,
  Error,
  ResumeTemplateVersionSaveRequest
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [...profileKeys.resumeTemplates(tenantId), "save"],
    mutationFn: (body) => api.saveResumeTemplate(body),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: profileKeys.resumeTemplates(tenantId) });
    },
  });
}

export function useSetDefaultResumeTemplateMutation(): UseMutationResult<
  ResumeTemplateDefaultSelectionResponse,
  Error,
  ResumeTemplateDefaultSelectionRequest
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [...profileKeys.resumeTemplates(tenantId), "default"],
    mutationFn: (body) => api.setDefaultResumeTemplate(body),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: profileKeys.resumeTemplates(tenantId) });
    },
  });
}
