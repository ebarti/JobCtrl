import type { TenantId } from "@jobctrl/domain-types";

export const evidenceMapKeys = {
  learning: (tenantId: TenantId) => [...evidenceMapKeys.list(tenantId), "learning"] as const,
  all: (tenantId: TenantId) => ["tenant", tenantId, "evidence-map"] as const,
  lists: (tenantId: TenantId) => [...evidenceMapKeys.all(tenantId), "list"] as const,
  list: (tenantId: TenantId) => [...evidenceMapKeys.lists(tenantId), "current"] as const,
  details: (tenantId: TenantId) => [...evidenceMapKeys.all(tenantId), "detail"] as const,
  detail: (tenantId: TenantId, entryId: string) =>
    [...evidenceMapKeys.details(tenantId), entryId] as const,
};
