import type { TenantId } from "@jobctrl/domain-types";

export const healthKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "health"] as const,
  live: (tenantId: TenantId) => [...healthKeys.all(tenantId), "live"] as const,
};
