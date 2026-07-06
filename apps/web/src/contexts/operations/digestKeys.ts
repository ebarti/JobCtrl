import type { TenantId } from "@jobhunter/domain-types";

export const digestKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "digest"] as const,
  summary: (tenantId: TenantId) => [...digestKeys.all(tenantId), "summary"] as const,
};
