import type { TenantId } from "@jobhunter/domain-types";

export const applyKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "apply"] as const,
};
