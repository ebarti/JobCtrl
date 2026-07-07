import type { TenantId } from "@jobctrl/domain-types";

import type { WorkflowRunsListInput } from "./types.js";

export const workflowRunsKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "workflow-runs"] as const,
  lists: (tenantId: TenantId) => [...workflowRunsKeys.all(tenantId), "list"] as const,
  list: (tenantId: TenantId, input: WorkflowRunsListInput) =>
    [...workflowRunsKeys.lists(tenantId), input] as const,
  details: (tenantId: TenantId) => [...workflowRunsKeys.all(tenantId), "detail"] as const,
  detail: (tenantId: TenantId, workflowId: string) =>
    [...workflowRunsKeys.details(tenantId), workflowId] as const,
};
