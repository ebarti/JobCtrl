import type { TenantId } from "@jobctrl/domain-types";

import { jobsKeys } from "../operations/jobsKeys.js";

export const materialsKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "materials"] as const,
  locales: (tenantId: TenantId, jobKey: string) => [...jobsKeys.detail(tenantId, jobKey), "materials", "locales"] as const,
};
