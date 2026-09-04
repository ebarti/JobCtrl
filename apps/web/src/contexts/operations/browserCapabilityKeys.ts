import type { TenantId } from "@jobctrl/domain-types";

export const browserCapabilityKeys = {
  capabilities: (tenantId: TenantId) => ["tenant", tenantId, "operations", "browser-capabilities"] as const,
  extensionPairing: (tenantId: TenantId) => ["tenant", tenantId, "profile", "extension-pairing"] as const,
  discoveryBrowserBridge: (tenantId: TenantId) => [
    "tenant",
    tenantId,
    "operations",
    "discovery-browser-bridge",
  ] as const,
};
