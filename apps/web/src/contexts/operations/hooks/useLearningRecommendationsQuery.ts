import type {
  LearningRecommendationEvidenceListQuery,
  LearningRecommendationEvidenceListResponse,
  LearningRecommendationListQuery,
  LearningRecommendationListResponse,
} from "@jobctrl/contracts";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { learningKeys } from "../learningKeys.js";

const DEFAULT_PAGE = { page: 1, pageSize: 50 } as const;

export function useLearningRecommendationsQuery(
  input: Partial<LearningRecommendationListQuery> = DEFAULT_PAGE,
): UseQueryResult<LearningRecommendationListResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: learningKeys.list(tenantId, input),
    queryFn: () => api.learningRecommendations(input),
  });
}

export function useLearningRecommendationEvidenceQuery(
  recommendationId: string,
  input: Partial<LearningRecommendationEvidenceListQuery> = DEFAULT_PAGE,
): UseQueryResult<LearningRecommendationEvidenceListResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: learningKeys.evidenceList(tenantId, recommendationId, input),
    queryFn: () => api.learningRecommendationEvidence(recommendationId, input),
  });
}
