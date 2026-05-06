import type { TenantId } from "@jobhunter/domain-types";

export const dashboardKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "dashboard"] as const,
  summary: (tenantId: TenantId) => [...dashboardKeys.all(tenantId), "summary"] as const,
};
