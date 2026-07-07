import type { TenantId } from "@jobctl/domain-types";

export const dashboardKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "dashboard"] as const,
  summary: (tenantId: TenantId) => [...dashboardKeys.all(tenantId), "summary"] as const,
};
