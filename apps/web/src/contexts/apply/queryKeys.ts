import type { TenantId } from "@jobctl/domain-types";

export const applyKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "apply"] as const,
};
