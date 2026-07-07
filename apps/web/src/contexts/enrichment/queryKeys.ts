import type { TenantId } from "@jobctrl/domain-types";

export const enrichmentKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "enrichment"] as const,
};
