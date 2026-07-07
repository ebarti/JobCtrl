import type { TenantId } from "@jobctrl/domain-types";

import type { JobId, JobsListInput } from "./types.js";

export const jobsKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "jobs"] as const,
  lists: (tenantId: TenantId) => [...jobsKeys.all(tenantId), "list"] as const,
  list: (tenantId: TenantId, input: JobsListInput) =>
    [...jobsKeys.lists(tenantId), input] as const,
  details: (tenantId: TenantId) => [...jobsKeys.all(tenantId), "detail"] as const,
  detail: (tenantId: TenantId, jobId: JobId) =>
    [...jobsKeys.details(tenantId), jobId] as const,
};
