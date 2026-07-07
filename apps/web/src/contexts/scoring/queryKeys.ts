import type { TenantId } from "@jobctl/domain-types";

export const scoringKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "scoring"] as const,
};
