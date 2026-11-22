import type { TenantId } from "@jobctrl/domain-types";

export const compensationKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "operations", "compensation"] as const,
  sources: (tenantId: TenantId) => [...compensationKeys.all(tenantId), "sources"] as const,
  evidence: (tenantId: TenantId, jobId: string) => [...compensationKeys.all(tenantId), "job", jobId] as const,
  comparison: (tenantId: TenantId, jobId: string) =>
    ["tenant", tenantId, "jobs", "detail", jobId, "offer-compensation"] as const,
};
