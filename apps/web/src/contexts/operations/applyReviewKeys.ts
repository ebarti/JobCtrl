import type { TenantId } from "@jobhunter/domain-types";

export const applyReviewKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "apply-review"] as const,
  queue: (tenantId: TenantId) => [...applyReviewKeys.all(tenantId), "queue"] as const,
};
