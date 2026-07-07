import type { TenantId } from "@jobctl/domain-types";

export const materialsKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "materials"] as const,
};
