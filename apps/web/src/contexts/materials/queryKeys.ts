import type { TenantId } from "@jobhunter/domain-types";

export const materialsKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "materials"] as const,
};
