import type { TenantId } from "@jobctl/domain-types";

export const digestKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "digest"] as const,
  summary: (tenantId: TenantId) => [...digestKeys.all(tenantId), "summary"] as const,
};
