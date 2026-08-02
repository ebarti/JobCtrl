import type {
  LearningRecommendationEvidenceListQuery,
  LearningRecommendationListQuery,
  TailoringPolicyRevisionListQuery,
} from "@jobctrl/contracts";
import type { TenantId } from "@jobctrl/domain-types";

export const learningKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "operations", "learning"] as const,
  lists: (tenantId: TenantId) => [...learningKeys.all(tenantId), "recommendations"] as const,
  list: (tenantId: TenantId, input: Partial<LearningRecommendationListQuery>) =>
    [...learningKeys.lists(tenantId), input] as const,
  evidence: (tenantId: TenantId) => [...learningKeys.all(tenantId), "evidence"] as const,
  evidenceList: (
    tenantId: TenantId,
    recommendationId: string,
    input: Partial<LearningRecommendationEvidenceListQuery>,
  ) => [...learningKeys.evidence(tenantId), recommendationId, input] as const,
  policyRevisions: (tenantId: TenantId) =>
    [...learningKeys.all(tenantId), "policies", "materials"] as const,
  policyRevisionList: (
    tenantId: TenantId,
    input: Partial<TailoringPolicyRevisionListQuery>,
  ) => [...learningKeys.policyRevisions(tenantId), input] as const,
};
