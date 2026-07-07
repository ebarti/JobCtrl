import type { TenantId } from "@jobctrl/domain-types";

export const scoringKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "scoring"] as const,
};
