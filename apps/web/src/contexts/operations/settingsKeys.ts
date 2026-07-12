import type { TenantId } from "@jobctrl/domain-types";

export const settingsKeys = {
  settings: (tenantId: TenantId) => ["tenant", tenantId, "profile", "settings"] as const,
  providerModels: (tenantId: TenantId) => ["tenant", tenantId, "profile", "provider-models"] as const,
};
