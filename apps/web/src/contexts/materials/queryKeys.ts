import type { TenantId } from "@jobctrl/domain-types";

export const materialsKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "materials"] as const,
};
