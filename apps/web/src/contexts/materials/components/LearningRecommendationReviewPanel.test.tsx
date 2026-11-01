import type {
  LearningRecommendationEvidenceListResponse,
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

  it("keeps the current page and accepted decisions during later-page failures and retries", async () => {
    const user = userEvent.setup();
    let current = Array.from({ length: 52 }, (_, index) => ({
      ...sampleLearningRecommendation,
      recommendationId: `learning-recommendation:${index.toString(16).padStart(64, "0")}`,
      ruleKey: `synthetic_${index}`,
      active: index !== 51,
      tombstoneCount: index === 51 ? 1 : 0,
    }));
    const acceptedId = current[0]!.recommendationId;
    const inspectedId = current[1]!.recommendationId;
    const links = Array.from({ length: 102 }, (_, index) => ({
      ...sampleLearningRecommendationEvidence.evidence[0]!,
      signalId: index >= 100 ? "synthetic-shared-signal" : `synthetic-signal-${index}`,
      jobId: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
    }));
    let listFailures = 1;
    let evidenceFailures = 1;
    const learningRecommendations = vi.fn(async (query?: { page?: unknown; pageSize?: unknown }): Promise<LearningRecommendationListResponse> => {
      const page = Number(query?.page ?? 1);
      const pageSize = Number(query?.pageSize ?? 50);
      if (page === 2 && listFailures-- > 0) throw new Error("List page temporarily unavailable.");
      return { ok: true, recommendations: current.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: current.length, totalPages: Math.ceil(current.length / pageSize) };
    });
    const learningRecommendationEvidence = vi.fn(async (recommendationId: string, query?: { page?: number; pageSize?: number }): Promise<LearningRecommendationEvidenceListResponse> => {
      const page = query?.page ?? 1;
      const pageSize = query?.pageSize ?? 100;
      if (page === 2 && evidenceFailures-- > 0) throw new Error("Evidence page temporarily unavailable.");
      return { ok: true, recommendationId, evidence: links.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: links.length, totalPages: Math.ceil(links.length / pageSize) };
    });
    const reviewLearningRecommendation = vi.fn(async (recommendationId: string, body: LearningRecommendationReviewRequest) => {
      current = current.filter((item) => item.recommendationId !== recommendationId);
      return reviewResponse(recommendationId, body.decision);
    });
    renderWithProviders(<LearningRecommendationReviewPanel />, {
      ports: buildTestPorts({ api: { learningRecommendations, learningRecommendationEvidence, reviewLearningRecommendation } }),
    });

    await screen.findByText("synthetic_0 → preserve_user_edit_pattern");
    const listPages = screen.getByRole("navigation", { name: "Learning recommendations pages" });
    expect(within(listPages).getByText("Page 1 of 2 · Showing 50 of 52 review items")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Accept learning recommendation synthetic_0 → preserve_user_edit_pattern" }));
    await waitFor(() => expect(within(listPages).getByText("Page 1 of 2 · Showing 50 of 51 review items")).toBeInTheDocument());
    expect(reviewLearningRecommendation).toHaveBeenCalledWith(acceptedId, { decision: "accepted" });

    await user.click(screen.getByRole("button", { name: "Inspect evidence for synthetic_1 → preserve_user_edit_pattern" }));
    const evidencePages = await screen.findByRole("navigation", { name: "Evidence for synthetic_1 → preserve_user_edit_pattern pages" });
    expect(within(evidencePages).getByText("Page 1 of 2 · Showing 100 of 102 evidence links")).toBeInTheDocument();
    await user.click(within(evidencePages).getByRole("button", { name: "Next page" }));
    expect(await within(evidencePages).findByText("Could not load page 2")).toBeInTheDocument();
    expect(screen.getByText("synthetic-signal-0")).toBeInTheDocument();
    expect(within(evidencePages).getByText("Page 1 of 2 · Showing 100 of 102 evidence links")).toBeInTheDocument();
    await user.click(within(evidencePages).getByRole("button", { name: "Retry page 2" }));
    expect(await within(evidencePages).findByText("Page 2 of 2 · Showing 2 of 102 evidence links")).toBeInTheDocument();
    expect(screen.getAllByText("synthetic-shared-signal")).toHaveLength(2);
    expect(screen.getByText(/job 00000000-0000-4000-8000-000000000100/)).toBeInTheDocument();
    expect(screen.getByText(/job 00000000-0000-4000-8000-000000000101/)).toBeInTheDocument();
    expect(learningRecommendationEvidence).toHaveBeenLastCalledWith(inspectedId, { page: 2, pageSize: 100 });

    await user.click(within(listPages).getByRole("button", { name: "Next page" }));
    expect(await within(listPages).findByText("Could not load page 2")).toBeInTheDocument();
    expect(screen.getByText("synthetic_1 → preserve_user_edit_pattern")).toBeInTheDocument();
    expect(screen.queryByText("synthetic_0 → preserve_user_edit_pattern")).not.toBeInTheDocument();
    await user.click(within(listPages).getByRole("button", { name: "Retry page 2" }));
    expect(await within(listPages).findByText("Page 2 of 2 · Showing 1 of 51 review items")).toBeInTheDocument();
    const tombstoned = screen.getByRole("article", { name: "synthetic_51 → preserve_user_edit_pattern" });
    expect(within(tombstoned).getByText(/source evidence was tombstoned/)).toBeInTheDocument();
    expect(within(tombstoned).getByRole("button", { name: /accept learning recommendation/i })).toBeDisabled();
    await user.click(within(listPages).getByRole("button", { name: "Previous page" }));
    await screen.findByText("synthetic_1 → preserve_user_edit_pattern");
    expect(screen.queryByText("synthetic_0 → preserve_user_edit_pattern")).not.toBeInTheDocument();
    expect(reviewLearningRecommendation).toHaveBeenCalledTimes(1);
  });

  it("keeps navigation available when a review removes the last item on the last page", async () => {
    const user = userEvent.setup();
    let current = Array.from({ length: 51 }, (_, index) => ({
      ...sampleLearningRecommendation,
      recommendationId: `learning-recommendation:${index.toString(16).padStart(64, "0")}`,
      ruleKey: `synthetic_${index}`,
    }));
    const learningRecommendations = vi.fn(async (query?: { page?: unknown; pageSize?: unknown }): Promise<LearningRecommendationListResponse> => {
      const page = Number(query?.page ?? 1);
      const pageSize = Number(query?.pageSize ?? 50);
      return { ok: true, recommendations: current.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: current.length, totalPages: Math.ceil(current.length / pageSize) };
    });
    const reviewLearningRecommendation = vi.fn(async (recommendationId: string, body: LearningRecommendationReviewRequest) => {
      current = current.filter((item) => item.recommendationId !== recommendationId);
      return reviewResponse(recommendationId, body.decision);
    });
    renderWithProviders(<LearningRecommendationReviewPanel />, {
      ports: buildTestPorts({ api: { learningRecommendations, reviewLearningRecommendation } }),
    });
    await screen.findByText("synthetic_0 → preserve_user_edit_pattern");
    const pages = screen.getByRole("navigation", { name: "Learning recommendations pages" });
    await user.click(within(pages).getByRole("button", { name: "Next page" }));
    await screen.findByText("synthetic_50 → preserve_user_edit_pattern");
    await user.click(screen.getByRole("button", { name: "Accept learning recommendation synthetic_50 → preserve_user_edit_pattern" }));
    expect(await screen.findByText("No recommendations on this page. Use the previous page to see remaining reviews.")).toBeInTheDocument();
    expect(within(pages).getByText("Page 2 · 1 page currently available · Showing 0 of 50 review items")).toBeInTheDocument();
    await user.click(within(pages).getByRole("button", { name: "Previous page" }));
    expect(await screen.findByText("synthetic_0 → preserve_user_edit_pattern")).toBeInTheDocument();
    expect(screen.queryByText("synthetic_50 → preserve_user_edit_pattern")).not.toBeInTheDocument();
  });
});
