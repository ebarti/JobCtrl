import type { TenantId } from "@jobhunter/domain-types";

import type { ActivityListInput } from "./types.js";

export const activityKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "activity"] as const,
  lists: (tenantId: TenantId) => [...activityKeys.all(tenantId), "list"] as const,
  list: (tenantId: TenantId, input: ActivityListInput) =>
    [...activityKeys.lists(tenantId), input] as const,
  details: (tenantId: TenantId) => [...activityKeys.all(tenantId), "detail"] as const,
  detail: (tenantId: TenantId, eventId: string) =>
    [...activityKeys.details(tenantId), eventId] as const,
};
