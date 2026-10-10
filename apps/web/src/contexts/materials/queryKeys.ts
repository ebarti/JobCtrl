import { jobsKeys } from "../operations/jobsKeys.js";
import type { TenantId } from "@jobctrl/domain-types";

export const materialsKeys = {
  locales: (tenantId: TenantId, jobId: string) => ["tenant", tenantId, "materials", "locales", jobId] as const,
  screening: (tenantId: TenantId, jobId: string) => [...jobsKeys.detail(tenantId, jobId), "screening-answers"] as const,
  all: (tenantId: TenantId) => ["tenant", tenantId, "materials"] as const,
};
