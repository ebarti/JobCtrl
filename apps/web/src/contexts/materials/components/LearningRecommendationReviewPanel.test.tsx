import type {
  LearningRecommendationListResponse,
  LearningRecommendationReviewRequest,
  LearningRecommendationReviewResponse,
} from "@jobctrl/contracts";
import { act, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";

import {
  sampleLearningRecommendation,
  sampleLearningRecommendationEvidence,
  sampleLearningRecommendationList,
  sampleSecondLearningRecommendation,
} from "../../../test/fixtures/learning.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { LearningRecommendationReviewPanel } from "./LearningRecommendationReviewPanel.js";

function reviewResponse(
  recommendationId: string,
  decision: LearningRecommendationReviewRequest["decision"],
): LearningRecommendationReviewResponse {
  const base = {
    ok: true as const,
    reviewId: `learning-recommendation-review:${
      decision === "accepted" ? "c".repeat(64) : "d".repeat(64)
    }`,
    recommendationId,
    revision: 1,
    decision,
    context: "materials" as const,
    policyKind: "tailoring_rule" as const,
    reviewedAt: "2026-08-01T12:05:00.000Z",
  };
  return decision === "accepted"
    ? { ...base, decision, policyVersion: 2 }
    : { ...base, decision, policyVersion: null };
}

describe("LearningRecommendationReviewPanel", () => {
  it("has no axe violations with pending recommendations", async () => {
    const view = renderWithProviders(<LearningRecommendationReviewPanel />, {
      ports: buildTestPorts({
        api: {
          learningRecommendations: vi.fn(async () => sampleLearningRecommendationList),
        },
      }),
    });

    await screen.findByText("style_guidance → preserve_user_edit_pattern");
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it("defers and exposes only bounded evidence after explicit inspection", async () => {
    const user = userEvent.setup();
    const learningRecommendations = vi.fn(async () => sampleLearningRecommendationList);
    const learningRecommendationEvidence = vi.fn(async () => sampleLearningRecommendationEvidence);
    renderWithProviders(<LearningRecommendationReviewPanel />, {
      ports: buildTestPorts({ api: { learningRecommendations, learningRecommendationEvidence } }),
    });

    expect(
      await screen.findByText("style_guidance → preserve_user_edit_pattern"),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(/3 of 3 required accepted signals across 2 of 2 required jobs/i),
    ).toHaveLength(2);
    expect(screen.getByText(/3 supporting · 1 contradicting · 0 tombstones/i)).toBeInTheDocument();
    expect(screen.getAllByText(/sample-gated recommendation only/i)).not.toHaveLength(0);
    expect(learningRecommendationEvidence).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", {
        name: /inspect evidence for style_guidance → preserve_user_edit_pattern/i,
      }),
    );

    const evidence = await screen.findByRole("list", {
      name: /evidence for style_guidance → preserve_user_edit_pattern/i,
    });
    expect(within(evidence).getByText("tailoring-signal-supporting-1")).toBeInTheDocument();
    expect(within(evidence).getByText("tailoring-signal-contradicting-1")).toBeInTheDocument();
    expect(within(evidence).getByText("contradicting")).toBeInTheDocument();
    expect(learningRecommendationEvidence).toHaveBeenCalledWith(
      sampleLearningRecommendation.recommendationId,
      { page: 1, pageSize: 100 },
    );
  });

  it("accepts and rejects without triggering rescore or re-tailor work", async () => {
    const user = userEvent.setup();
    let current = [...sampleLearningRecommendationList.recommendations];
    const learningRecommendations = vi.fn(async (): Promise<LearningRecommendationListResponse> => ({
      ...sampleLearningRecommendationList,
      recommendations: current,
      total: current.length,
      totalPages: current.length ? 1 : 0,
    }));
    const reviewLearningRecommendation = vi.fn(
      async (recommendationId: string, body: LearningRecommendationReviewRequest) => {
        current = current.filter((item) => item.recommendationId !== recommendationId);
        return reviewResponse(recommendationId, body.decision);
      },
    );
    const rescoreJob = vi.fn();
    const retailorJob = vi.fn();
    renderWithProviders(<LearningRecommendationReviewPanel />, {
      ports: buildTestPorts({
        api: { learningRecommendations, reviewLearningRecommendation, rescoreJob, retailorJob },
      }),
    });

    await screen.findByText("style_guidance → preserve_user_edit_pattern");
    await user.click(
      screen.getByRole("button", {
        name: /accept learning recommendation style_guidance → preserve_user_edit_pattern/i,
      }),
    );
    await waitFor(() =>
      expect(reviewLearningRecommendation).toHaveBeenCalledWith(
        sampleLearningRecommendation.recommendationId,
        { decision: "accepted" },
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText("style_guidance → preserve_user_edit_pattern")).not.toBeInTheDocument(),
    );

    await user.click(
      screen.getByRole("button", {
        name: /reject learning recommendation fact_handling → require_source_match/i,
      }),
    );
    await waitFor(() =>
      expect(reviewLearningRecommendation).toHaveBeenCalledWith(
        sampleSecondLearningRecommendation.recommendationId,
        { decision: "rejected" },
      ),
    );
    expect(rescoreJob).not.toHaveBeenCalled();
    expect(retailorJob).not.toHaveBeenCalled();
  });

  it("restores the recommendation and surfaces a sanitized review error", async () => {
    const user = userEvent.setup();
    let rejectReview: ((error: Error) => void) | undefined;
    const learningRecommendations = vi.fn(async (): Promise<LearningRecommendationListResponse> => ({
      ...sampleLearningRecommendationList,
      recommendations: [sampleLearningRecommendation],
      total: 1,
      totalPages: 1,
    }));
    const reviewLearningRecommendation = vi.fn(
      () =>
        new Promise<LearningRecommendationReviewResponse>((_resolve, reject) => {
          rejectReview = reject;
        }),
    );
    renderWithProviders(<LearningRecommendationReviewPanel />, {
      ports: buildTestPorts({ api: { learningRecommendations, reviewLearningRecommendation } }),
    });

    await screen.findByText("style_guidance → preserve_user_edit_pattern");
    await user.click(
      screen.getByRole("button", {
        name: /reject learning recommendation style_guidance → preserve_user_edit_pattern/i,
      }),
    );
    expect(await screen.findByText("No learning recommendations to review.")).toBeInTheDocument();
    act(() => rejectReview?.(new Error("The learning recommendation review could not be completed.")));

    expect(await screen.findByText("Recommendation review failed")).toBeInTheDocument();
    expect(
      await screen.findByText("style_guidance → preserve_user_edit_pattern"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The learning recommendation review could not be completed."),
    ).toBeInTheDocument();
  });

  it("marks tombstoned recommendations inactive and prevents guaranteed-failing reviews", async () => {
    const reviewLearningRecommendation = vi.fn();
    renderWithProviders(<LearningRecommendationReviewPanel />, {
      ports: buildTestPorts({
        api: {
          learningRecommendations: vi.fn(async () => ({
            ...sampleLearningRecommendationList,
            recommendations: [
              {
                ...sampleLearningRecommendation,
                active: false,
                tombstoneCount: 1,
              },
            ],
            total: 1,
          })),
          reviewLearningRecommendation,
        },
      }),
    });

    await screen.findByText("style_guidance → preserve_user_edit_pattern");
    expect(screen.getByText("1 review item")).toBeInTheDocument();
    expect(screen.queryByText(/1 pending/i)).not.toBeInTheDocument();
    expect(screen.getByText("Inactive")).toBeInTheDocument();
    expect(
      screen.getByText(/source evidence was tombstoned, so this recommendation must be re-derived/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /accept learning recommendation style_guidance → preserve_user_edit_pattern/i,
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", {
        name: /reject learning recommendation style_guidance → preserve_user_edit_pattern/i,
      }),
    ).toBeDisabled();
    expect(reviewLearningRecommendation).not.toHaveBeenCalled();
  });
});
