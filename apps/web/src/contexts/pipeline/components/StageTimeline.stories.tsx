import type { StageSummary } from "@jobhunter/contracts";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { StageTimeline } from "./StageTimeline.js";

const meta = {
  title: "Contexts/Pipeline/StageTimeline",
  component: StageTimeline,
} satisfies Meta<typeof StageTimeline>;

export default meta;
type Story = StoryObj<typeof meta>;

function makeStage(stage: StageSummary["stage"], state: StageSummary["state"], extras: Partial<StageSummary> = {}): StageSummary {
  return {
    stage,
    state,
    attemptCount: state === "succeeded" ? 1 : 0,
    maxAttempts: 3,
    startedAt: state === "pending" ? null : "2026-05-01T12:00:00Z",
    updatedAt: "2026-05-01T12:00:30Z",
    finishedAt: state === "succeeded" ? "2026-05-01T12:00:30Z" : null,
    durationMs: state === "succeeded" ? 30_000 : null,
    errorCode: null,
    errorMessage: null,
    retryable: state === "failed",
    blockedBy: [],
    nextAction: null,
    ...extras,
  };
}

export const HappyPath: Story = {
  args: {
    stages: [
      makeStage("discover", "succeeded"),
      makeStage("score", "succeeded"),
      makeStage("tailor", "succeeded"),
      makeStage("apply", "running", { nextAction: "Posting application…" }),
    ],
  },
};

export const PartialFailure: Story = {
  args: {
    stages: [
      makeStage("discover", "succeeded"),
      makeStage("score", "succeeded"),
      makeStage("tailor", "failed", {
        errorCode: "tailor_llm_quota",
        errorMessage: "LLM quota exceeded.",
        retryable: true,
        nextAction: "Retry stage",
      }),
      makeStage("apply", "blocked", { blockedBy: ["tailor"] }),
    ],
  },
};

export const Empty: Story = {
  args: { stages: [] },
};
