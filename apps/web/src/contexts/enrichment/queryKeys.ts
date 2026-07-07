import type { TenantId } from "@jobctl/domain-types";

export const enrichmentKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "enrichment"] as const,
};
