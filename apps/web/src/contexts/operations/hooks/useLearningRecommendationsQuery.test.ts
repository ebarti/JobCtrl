import type {
  LearningRecommendationEvidenceListResponse,
  LearningRecommendationListResponse,
} from "@jobctrl/contracts";
import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import {
  useLearningRecommendationEvidenceQuery,
  useLearningRecommendationsQuery,
} from "./useLearningRecommendationsQuery.js";

const recommendationId = `learning-recommendation:${"a".repeat(64)}`;

const recommendationList: LearningRecommendationListResponse = {
  ok: true,
  recommendations: [],
  page: 2,
  pageSize: 10,
  total: 0,
  totalPages: 0,
};

const evidenceList: LearningRecommendationEvidenceListResponse = {
  ok: true,
  recommendationId,
  evidence: [],
  page: 1,
  pageSize: 25,
  total: 0,
  totalPages: 0,
};

describe("learning recommendation queries", () => {
  it("reads one tenant-scoped recommendation page through the API port", async () => {
    const learningRecommendations = vi.fn(async () => recommendationList);
    const { result } = renderHookWithProviders(
      () => useLearningRecommendationsQuery({ page: 2, pageSize: 10 }),
      { ports: buildTestPorts({ api: { learningRecommendations } }) },
    );

    await waitFor(() => expect(result.current.data).toBe(recommendationList));
    expect(learningRecommendations).toHaveBeenCalledWith({ page: 2, pageSize: 10 });
  });

  it("reads bounded evidence for one recommendation through the API port", async () => {
    const learningRecommendationEvidence = vi.fn(async () => evidenceList);
    const { result } = renderHookWithProviders(
      () => useLearningRecommendationEvidenceQuery(recommendationId, { page: 1, pageSize: 25 }),
      { ports: buildTestPorts({ api: { learningRecommendationEvidence } }) },
    );

    await waitFor(() => expect(result.current.data).toBe(evidenceList));
    expect(learningRecommendationEvidence).toHaveBeenCalledWith(recommendationId, {
      page: 1,
      pageSize: 25,
    });
  });

  it("defers evidence reads until inspection is enabled", async () => {
    const learningRecommendationEvidence = vi.fn(async () => evidenceList);
    const { result, rerender } = renderHookWithProviders(
      ({ enabled }: { enabled: boolean }) =>
        useLearningRecommendationEvidenceQuery(
          recommendationId,
          { page: 1, pageSize: 25 },
          enabled,
        ),
      {
        initialProps: { enabled: false },
        ports: buildTestPorts({ api: { learningRecommendationEvidence } }),
      },
    );

    expect(result.current.fetchStatus).toBe("idle");
    expect(learningRecommendationEvidence).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.data).toBe(evidenceList));
    expect(learningRecommendationEvidence).toHaveBeenCalledTimes(1);
  });
});
