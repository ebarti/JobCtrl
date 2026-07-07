import type { TenantId } from "@jobctl/domain-types";

import type { JobId } from "./types.js";

export const outcomesKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "outcomes"] as const,
  lists: (tenantId: TenantId) => [...outcomesKeys.all(tenantId), "list"] as const,
  list: (tenantId: TenantId) => [...outcomesKeys.lists(tenantId), "global"] as const,
  details: (tenantId: TenantId) => [...outcomesKeys.all(tenantId), "job"] as const,
  detail: (tenantId: TenantId, jobId: JobId) =>
    [...outcomesKeys.details(tenantId), jobId] as const,
};
