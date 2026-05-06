import type { TenantId } from "@jobhunter/domain-types";

export const healthKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "health"] as const,
  live: (tenantId: TenantId) => [...healthKeys.all(tenantId), "live"] as const,
};
