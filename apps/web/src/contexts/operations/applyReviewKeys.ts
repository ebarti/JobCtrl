import type { TenantId } from "@jobctrl/domain-types";

export const applyReviewKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "apply-review"] as const,
  queue: (tenantId: TenantId) => [...applyReviewKeys.all(tenantId), "queue"] as const,
  drafts: (tenantId: TenantId) => [...applyReviewKeys.all(tenantId), "drafts"] as const,
  draft: (tenantId: TenantId, jobId: string) => [...applyReviewKeys.drafts(tenantId), jobId] as const,
  feedback: (tenantId: TenantId, jobId: string) =>
    [...applyReviewKeys.all(tenantId), "feedback", jobId] as const,
};
