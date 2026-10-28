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

interface SaveTemplateVariables {
  readonly body: ResumeTemplateVersionSaveRequest;
  readonly makeDefault: boolean;
}

interface SaveTemplateResult {
  readonly saved: ResumeTemplateVersionSaveResponse;
  readonly defaultError: Error | null;
}

export function useSaveResumeTemplateMutation(): UseMutationResult<
  SaveTemplateResult,
  Error,
  SaveTemplateVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [...profileKeys.resumeTemplates(tenantId), "save"],
    mutationFn: async ({ body, makeDefault }) => {
      const saved = await api.saveResumeTemplate(body);
      if (!makeDefault) return { saved, defaultError: null };
      try {
        await api.setDefaultResumeTemplate({
          templateId: saved.template.templateId,
          versionId: saved.template.activeVersion.versionId,
        });
        return { saved, defaultError: null };
      } catch (error) {
        return { saved, defaultError: error instanceof Error ? error : new Error(String(error)) };
      }
    },
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
