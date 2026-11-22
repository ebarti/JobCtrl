import type { TenantId } from "@jobctrl/domain-types";

/** Preserve the existing tenant-first cache identity while Offers owns its reads. */
export const offerKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "outcomes", "job"] as const,
  detail: (tenantId: TenantId, jobId: string) => [...offerKeys.all(tenantId), jobId, "offer"] as const,
};
