import type { TenantId } from "@jobhunter/domain-types";

export const discoveryKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "discovery"] as const,
};
