import type { TenantId } from "@jobctrl/domain-types";

export const profileKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "profile"] as const,
  profile: (tenantId: TenantId) => [...profileKeys.all(tenantId), "profile"] as const,
  settings: (tenantId: TenantId) => [...profileKeys.all(tenantId), "settings"] as const,
  extensionPairing: (tenantId: TenantId) =>
    [...profileKeys.all(tenantId), "extension-pairing"] as const,
  credentials: (tenantId: TenantId) => [...profileKeys.all(tenantId), "credentials"] as const,
  providerStatus: (tenantId: TenantId) =>
    [...profileKeys.all(tenantId), "provider-status"] as const,
  resumeTemplates: (tenantId: TenantId) =>
    [...profileKeys.all(tenantId), "resume-templates"] as const,
};
