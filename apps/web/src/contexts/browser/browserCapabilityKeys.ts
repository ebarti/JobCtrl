import type { TenantId } from "@jobctrl/domain-types";

export const browserCapabilityKeys = {
  capabilities: (tenantId: TenantId) => ["tenant", tenantId, "browser", "capabilities"] as const,
  extensionPairing: (tenantId: TenantId) => ["tenant", tenantId, "browser", "extension-pairing"] as const,
  discoveryBrowserBridge: (tenantId: TenantId) => [
    "tenant",
    tenantId,
    "browser",
    "discovery-browser-bridge",
  ] as const,
};
