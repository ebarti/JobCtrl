import type { TenantId } from "@jobhunter/domain-types";

export const discoveryKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "discovery"] as const,
  sourceLocator: (tenantId: TenantId) =>
    ["tenant", tenantId, "discovery", "source-locator"] as const,
  sourceRegistry: (tenantId: TenantId) =>
    ["tenant", tenantId, "discovery", "source-registry"] as const,
  sourceQuality: (tenantId: TenantId) =>
    ["tenant", tenantId, "discovery", "source-quality"] as const,
};
