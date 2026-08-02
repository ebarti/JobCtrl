import type {
  LearningRecommendationListResponse,
  LearningRecommendationReviewRequest,
  LearningRecommendationReviewResponse,
} from "@jobctrl/contracts";
import {
  useMutation,
  useQueryClient,
  type QueryKey,
  type UseMutationResult,
} from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { learningKeys } from "../../operations/learningKeys.js";

export interface ReviewLearningRecommendationVariables {
  readonly recommendationId: string;
  readonly decision: LearningRecommendationReviewRequest["decision"];
}

interface ReviewLearningRecommendationContext {
  readonly snapshots: readonly (readonly [QueryKey, LearningRecommendationListResponse | undefined])[];
}

export function useReviewLearningRecommendationMutation(): UseMutationResult<
  LearningRecommendationReviewResponse,
  Error,
  ReviewLearningRecommendationVariables,
  ReviewLearningRecommendationContext
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ recommendationId, decision }) =>
      api.reviewLearningRecommendation(recommendationId, { decision }),
    onMutate: async ({ recommendationId }) => {
      await queryClient.cancelQueries({ queryKey: learningKeys.lists(tenantId) });
      const snapshots = queryClient.getQueriesData<LearningRecommendationListResponse>({
        queryKey: learningKeys.lists(tenantId),
      });
      const isCached = snapshots.some(([, snapshot]) =>
        snapshot?.recommendations.some((item) => item.recommendationId === recommendationId),
      );
      for (const [queryKey] of isCached ? snapshots : []) {
        queryClient.setQueryData<LearningRecommendationListResponse>(queryKey, (current) =>
          removePendingRecommendation(current, recommendationId),
        );
      }
      return { snapshots };
    },
    onError: (_error, _variables, context) => {
      for (const [queryKey, snapshot] of context?.snapshots ?? []) {
        queryClient.setQueryData(queryKey, snapshot);
      }
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: learningKeys.lists(tenantId) });
    },
  });
}

function removePendingRecommendation(
  current: LearningRecommendationListResponse | undefined,
  recommendationId: string,
): LearningRecommendationListResponse | undefined {
  if (!current) {
    return current;
  }
  const total = Math.max(0, current.total - 1);
  return {
    ...current,
    recommendations: current.recommendations.filter(
      (item) => item.recommendationId !== recommendationId,
    ),
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / current.pageSize),
  };
}
