import type { TenantId } from "@jobhunter/domain-types";

export const discoveryKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "discovery"] as const,
  sourceLocator: (tenantId: TenantId) =>
    ["tenant", tenantId, "discovery", "source-locator"] as const,
  sourceRegistry: (tenantId: TenantId) =>
    ["tenant", tenantId, "discovery", "source-registry"] as const,
  sourcePreview: (tenantId: TenantId, sourceId: string) =>
    ["tenant", tenantId, "discovery", "source-preview", sourceId] as const,
  sourceQuality: (tenantId: TenantId) =>
    ["tenant", tenantId, "discovery", "source-quality"] as const,
  quarantine: (tenantId: TenantId) =>
    ["tenant", tenantId, "discovery", "quarantine"] as const,
  manualCapture: (tenantId: TenantId) =>
    ["tenant", tenantId, "discovery", "manual-capture"] as const,
  feedback: (tenantId: TenantId) =>
    ["tenant", tenantId, "discovery", "feedback"] as const,
};
