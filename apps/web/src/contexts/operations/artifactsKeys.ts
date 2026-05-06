import type { TenantId } from "@jobhunter/domain-types";

import type { ArtifactsListInput } from "./types.js";

export const artifactsKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "artifacts"] as const,
  lists: (tenantId: TenantId) => [...artifactsKeys.all(tenantId), "list"] as const,
  list: (tenantId: TenantId, input: ArtifactsListInput) =>
    [...artifactsKeys.lists(tenantId), input] as const,
  details: (tenantId: TenantId) => [...artifactsKeys.all(tenantId), "detail"] as const,
  detail: (tenantId: TenantId, artifactId: string) =>
    [...artifactsKeys.details(tenantId), artifactId] as const,
};
