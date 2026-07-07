import type { TenantId } from "@jobctrl/domain-types";

export const applyKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "apply"] as const,
};
