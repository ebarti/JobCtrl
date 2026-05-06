import type { TenantId } from "@jobhunter/domain-types";

export const scoringKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "scoring"] as const,
};
