import type {
  ResumeTemplateDefaultSelectionRequest,
  ResumeTemplateDefaultSelectionResponse,
  ResumeTemplateVersionSaveRequest,
  ResumeTemplateVersionSaveResponse,
} from "@jobctrl/contracts";
import { useMutation, useQueryClient, type QueryClient, type UseMutationResult } from "@tanstack/react-query";
import type { TenantId } from "@jobctrl/domain-types";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { profileKeys } from "../queryKeys.js";

interface SaveTemplateVariables {
  readonly body: ResumeTemplateVersionSaveRequest;
  readonly makeDefault: boolean;
  readonly maySetDefault?: (saved: ResumeTemplateVersionSaveResponse) => boolean;
}

interface SaveTemplateResult {
  readonly saved: ResumeTemplateVersionSaveResponse;
  readonly defaultError: Error | null;
}

export interface ResumeTemplateReadFence {
  readonly queryId: symbol | null;
  readonly readCount: number;
}

// Query counters restart after eviction. Keep identities weak so the fence
// does not retain an otherwise collectable query and its cached data.
const queryIds = new WeakMap<object, symbol>();

function templateReadFence(queryClient: QueryClient, tenantId: TenantId): ResumeTemplateReadFence {
  const query = queryClient.getQueryCache().find({ queryKey: profileKeys.resumeTemplates(tenantId), exact: true });
  if (!query) return { queryId: null, readCount: 0 };
  let queryId = queryIds.get(query);
  if (!queryId) {
    queryId = Symbol();
    queryIds.set(query, queryId);
  }
  return { queryId, readCount: query.state.dataUpdateCount };
}

export function hasTemplateReadAfter(
  queryClient: QueryClient,
  tenantId: TenantId,
  fence: ResumeTemplateReadFence,
): boolean {
  const current = templateReadFence(queryClient, tenantId);
  return current.queryId !== null && current.readCount > 0 &&
    (current.queryId !== fence.queryId || current.readCount > fence.readCount);
}

export class UnconfirmedTemplateDefaultError extends Error {
  constructor(error: unknown, readonly readFence: ResumeTemplateReadFence, prefix = "") {
    super(`${prefix}${error instanceof Error ? error.message : String(error)}`, { cause: error });
    this.name = "UnconfirmedTemplateDefaultError";
  }
}

async function fenceUnconfirmedDefault(
  error: unknown,
  queryClient: QueryClient,
  tenantId: TenantId,
  prefix = "",
): Promise<UnconfirmedTemplateDefaultError> {
  const queryKey = profileKeys.resumeTemplates(tenantId);
  // A read started before the failed response cannot confirm that response.
  await queryClient.cancelQueries({ queryKey, exact: true });
  return new UnconfirmedTemplateDefaultError(error, templateReadFence(queryClient, tenantId), prefix);
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
    mutationFn: async ({ body, makeDefault, maySetDefault }) => {
      const saved = await api.saveResumeTemplate(body);
      if (!makeDefault) return { saved, defaultError: null };
      if (maySetDefault && !maySetDefault(saved)) {
        return { saved, defaultError: new Error("The version was saved, but the template changed during the save. Review it before setting a default.") };
      }
      try {
        await api.setDefaultResumeTemplate({
          templateId: saved.template.templateId,
          versionId: saved.template.activeVersion.versionId,
          expectedActiveVersionId: saved.template.activeVersion.versionId,
        });
        return { saved, defaultError: null };
      } catch (error) {
        return {
          saved,
          defaultError: await fenceUnconfirmedDefault(
            error, queryClient, tenantId, "The version was saved, but the default change was not confirmed: ",
          ),
        };
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: profileKeys.resumeTemplates(tenantId) });
    },
  });
}

export function useSetDefaultResumeTemplateMutation(): UseMutationResult<
  ResumeTemplateDefaultSelectionResponse,
  UnconfirmedTemplateDefaultError,
  ResumeTemplateDefaultSelectionRequest
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [...profileKeys.resumeTemplates(tenantId), "default"],
    meta: { suppressGlobalErrorToast: true },
    mutationFn: async (body) => {
      try {
        return await api.setDefaultResumeTemplate(body);
      } catch (error) {
        throw await fenceUnconfirmedDefault(error, queryClient, tenantId);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: profileKeys.resumeTemplates(tenantId) });
    },
  });
}
