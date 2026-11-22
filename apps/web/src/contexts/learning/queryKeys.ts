import type { TenantId } from "@jobctrl/domain-types";

export const careerLearningKeys = {
  // Preserve the existing cache identity for mounted consumers during migration.
  all: (tenantId: TenantId) => ["tenant", tenantId, "evidence-map", "list", "current", "learning"] as const,
};
