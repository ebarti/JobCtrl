import type { TenantId } from "@jobctrl/domain-types";

export const materialsKeys = {
  locales: (tenantId: TenantId, jobId: string) => ["tenant", tenantId, "materials", "locales", jobId] as const,
  all: (tenantId: TenantId) => ["tenant", tenantId, "materials"] as const,
};
