import type {
  LearningRecommendationEvidenceListQuery,
  LearningRecommendationListQuery,
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
};
