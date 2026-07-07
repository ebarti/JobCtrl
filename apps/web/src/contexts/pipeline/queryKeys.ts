import type { TenantId } from "@jobctrl/domain-types";

export const pipelineKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "pipeline"] as const,
};
