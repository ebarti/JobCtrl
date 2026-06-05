import type { StageSummary } from "@jobhunter/contracts";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { StageTimeline } from "./StageTimeline.js";

function makeStage(stage: StageSummary["stage"], state: StageSummary["state"]): StageSummary {
  return {
    stage,
    state,
    attemptCount: 0,
    maxAttempts: 3,
    startedAt: null,
    updatedAt: null,
    finishedAt: null,
    durationMs: null,
    errorCode: null,
    errorMessage: null,
    retryable: true,
    blockedBy: [],
    nextAction: null,
  };
}

describe("<StageTimeline>", () => {
  it("shows a manual tailor action on actionable tailor stages", () => {
    renderWithProviders(
      <StageTimeline
        jobId="job-1"
        stages={[makeStage("score", "succeeded"), makeStage("tailor", "pending")]}
      />,
    );

    expect(screen.getByRole("button", { name: "tailor this job" })).toBeInTheDocument();
  });

  it("does not show a manual tailor action after tailoring succeeds", () => {
    renderWithProviders(
      <StageTimeline jobId="job-1" stages={[makeStage("tailor", "succeeded")]} />,
    );

    expect(screen.queryByRole("button", { name: "tailor this job" })).not.toBeInTheDocument();
  });

  it("shows failed-stage diagnostics without raw next-action commands", () => {
    renderWithProviders(
      <StageTimeline
        stages={[
          {
            ...makeStage("enrich", "failed"),
            attemptCount: 1,
            durationMs: 20_000,
            errorCode: "DETAIL_ERROR",
            errorMessage: "no data extracted",
            nextAction: "jobhunter retry enrich https://example.com/jobs/1",
          },
        ]}
      />,
    );

    expect(screen.getByLabelText("enrich diagnostics")).toHaveTextContent("DETAIL_ERROR");
    expect(screen.getByLabelText("enrich diagnostics")).toHaveTextContent("no data extracted");
    expect(screen.getByLabelText("enrich diagnostics")).toHaveTextContent(/retry\s*available/);
    expect(screen.queryByText(/jobhunter retry enrich/i)).not.toBeInTheDocument();
  });
});
