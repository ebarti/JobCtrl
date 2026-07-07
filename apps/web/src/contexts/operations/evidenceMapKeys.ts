import type { TenantId } from "@jobctl/domain-types";

export const evidenceMapKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "evidence-map"] as const,
  lists: (tenantId: TenantId) => [...evidenceMapKeys.all(tenantId), "list"] as const,
  list: (tenantId: TenantId) => [...evidenceMapKeys.lists(tenantId), "current"] as const,
  details: (tenantId: TenantId) => [...evidenceMapKeys.all(tenantId), "detail"] as const,
  detail: (tenantId: TenantId, entryId: string) =>
    [...evidenceMapKeys.details(tenantId), entryId] as const,
};
