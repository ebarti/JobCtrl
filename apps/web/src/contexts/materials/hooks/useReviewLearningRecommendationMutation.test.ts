import type {
  LearningRecommendationListResponse,
  LearningRecommendationReviewResponse,
  LearningRecommendationSummary,
} from "@jobctrl/contracts";
import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { act, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { learningKeys } from "../../operations/learningKeys.js";
import { useReviewLearningRecommendationMutation } from "./useReviewLearningRecommendationMutation.js";

const recommendation: LearningRecommendationSummary = {
  recommendationId: `learning-recommendation:${"a".repeat(64)}`,
  derivationVersion: 1,
  evaluationFixtureVersion: 1,
  context: "materials",
  policyKind: "tailoring_rule",
  signalKind: "style_preference",
  ruleKey: "style_guidance",
  ruleValue: "preserve_user_edit_pattern",
  allowlistVersion: 1,
  status: "pending",
  active: true,
  observedSignalCount: 3,
  observedJobCount: 2,
  minimumSignalCount: 3,
  minimumJobCount: 2,
  confidenceLimit: "sample_gated_no_population_inference",
  supportingEvidenceCount: 3,
  contradictingEvidenceCount: 0,
  tombstoneCount: 0,
  derivedAt: "2026-08-01T12:00:00.000Z",
};

const otherRecommendation: LearningRecommendationSummary = {
  ...recommendation,
  recommendationId: `learning-recommendation:${"c".repeat(64)}`,
  ruleKey: "fact_handling",
  ruleValue: "require_source_match",
};

const pageOneInput = { page: 1, pageSize: 50 } as const;
const pageTwoInput = { page: 2, pageSize: 50 } as const;
const pageOne: LearningRecommendationListResponse = {
  ok: true,
  recommendations: [otherRecommendation],
  page: 1,
  pageSize: 50,
  total: 51,
  totalPages: 2,
};
const pageTwo: LearningRecommendationListResponse = {
  ok: true,
  recommendations: [recommendation],
  page: 2,
  pageSize: 50,
  total: 51,
  totalPages: 2,
};

const accepted: LearningRecommendationReviewResponse = {
  ok: true,
  reviewId: `learning-recommendation-review:${"b".repeat(64)}`,
  recommendationId: recommendation.recommendationId,
  revision: 1,
  decision: "accepted",
  context: "materials",
  policyKind: "tailoring_rule",
  policyVersion: 2,
  reviewedAt: "2026-08-01T12:05:00.000Z",
};

describe("useReviewLearningRecommendationMutation", () => {
  it("reviews through the Materials API port and removes the terminal recommendation", async () => {
    const reviewLearningRecommendation = vi.fn(async () => accepted);
    const { result, queryClient } = renderHookWithProviders(
      () => useReviewLearningRecommendationMutation(),
      { ports: buildTestPorts({ api: { reviewLearningRecommendation } }) },
    );
    const pageOneKey = learningKeys.list(LOCAL_TENANT, pageOneInput);
    const pageTwoKey = learningKeys.list(LOCAL_TENANT, pageTwoInput);
    queryClient.setQueryData(pageOneKey, pageOne);
    queryClient.setQueryData(pageTwoKey, pageTwo);

    await act(async () => {
      await expect(
        result.current.mutateAsync({
          recommendationId: recommendation.recommendationId,
          decision: "accepted",
        }),
      ).resolves.toBe(accepted);
    });

    expect(reviewLearningRecommendation).toHaveBeenCalledWith(recommendation.recommendationId, {
      decision: "accepted",
    });
    expect(queryClient.getQueryData<LearningRecommendationListResponse>(pageOneKey)).toMatchObject({
      recommendations: [otherRecommendation],
      total: 50,
      totalPages: 1,
    });
    expect(queryClient.getQueryData<LearningRecommendationListResponse>(pageTwoKey)).toMatchObject({
      recommendations: [],
      total: 50,
      totalPages: 1,
    });
  });

  it("restores every optimistic recommendation snapshot when review fails", async () => {
    let rejectReview: ((error: Error) => void) | undefined;
    const reviewLearningRecommendation = vi.fn(
      () =>
        new Promise<LearningRecommendationReviewResponse>((_resolve, reject) => {
          rejectReview = reject;
        }),
    );
    const { result, queryClient } = renderHookWithProviders(
      () => useReviewLearningRecommendationMutation(),
      { ports: buildTestPorts({ api: { reviewLearningRecommendation } }) },
    );
    const pageOneKey = learningKeys.list(LOCAL_TENANT, pageOneInput);
    const pageTwoKey = learningKeys.list(LOCAL_TENANT, pageTwoInput);
    queryClient.setQueryData(pageOneKey, pageOne);
    queryClient.setQueryData(pageTwoKey, pageTwo);

    act(() => {
      result.current.mutate({
        recommendationId: recommendation.recommendationId,
        decision: "rejected",
      });
    });

    await waitFor(() =>
      expect(
        queryClient.getQueryData<LearningRecommendationListResponse>(pageTwoKey)?.recommendations,
      ).toEqual([]),
    );
    expect(queryClient.getQueryData<LearningRecommendationListResponse>(pageOneKey)).toMatchObject({
      recommendations: [otherRecommendation],
      total: 50,
      totalPages: 1,
    });
    act(() => rejectReview?.(new Error("review unavailable")));
    await waitFor(() => expect(result.current.isError).toBe(true));
    await waitFor(() =>
      expect(queryClient.getQueryData<LearningRecommendationListResponse>(pageOneKey)).toEqual(
        pageOne,
      ),
    );
    expect(queryClient.getQueryData<LearningRecommendationListResponse>(pageTwoKey)).toEqual(
      pageTwo,
    );
  });
});
