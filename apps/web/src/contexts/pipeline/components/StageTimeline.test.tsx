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
});
