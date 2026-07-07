import type { TenantId } from "@jobctrl/domain-types";

export const compensationKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "operations", "compensation"] as const,
  sources: (tenantId: TenantId) => [...compensationKeys.all(tenantId), "sources"] as const,
};
