import type { TenantId } from "@jobhunter/domain-types";

export const enrichmentKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "enrichment"] as const,
};
