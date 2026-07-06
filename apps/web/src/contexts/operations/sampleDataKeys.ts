import type { TenantId } from "@jobhunter/domain-types";

export const sampleDataKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "sample-data"] as const,
  status: (tenantId: TenantId) => [...sampleDataKeys.all(tenantId), "status"] as const,
  ttfvProbe: (tenantId: TenantId) => [...sampleDataKeys.all(tenantId), "ttfv-probe"] as const,
};
