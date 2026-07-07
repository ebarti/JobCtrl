import type { TenantId } from "@jobctl/domain-types";

export interface OutcomeAnalyticsFilters {
  readonly dimension?: string;
}

export const analyticsKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "analytics"] as const,
  outcomes: (tenantId: TenantId, filters: OutcomeAnalyticsFilters = {}) =>
    [...analyticsKeys.all(tenantId), "outcomes", filters] as const,
};
