import type { TenantId } from "@jobhunter/domain-types";

export const pipelineKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "pipeline"] as const,
};
