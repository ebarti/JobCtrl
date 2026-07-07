import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Stage, StageState } from "@jobctl/contracts";

import { StageBadge } from "./StageBadge.js";

const meta = {
  title: "Contexts/Pipeline/StageBadge",
  component: StageBadge,
} satisfies Meta<typeof StageBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const StageDiscover: Story = { args: { stage: "discover" } };
export const StageEnrich: Story = { args: { stage: "enrich" } };
export const StageScore: Story = { args: { stage: "score" } };
export const StageTailor: Story = { args: { stage: "tailor" } };
export const StageCover: Story = { args: { stage: "cover" } };
export const StageApply: Story = { args: { stage: "apply" } };

export const StatePending: Story = { args: { state: "pending" } };
export const StateQueued: Story = { args: { state: "queued" } };
export const StateRunning: Story = { args: { state: "running" } };
export const StateSucceeded: Story = { args: { state: "succeeded" } };
export const StateFailed: Story = { args: { state: "failed" } };
export const StateBlocked: Story = { args: { state: "blocked" } };
export const StateSkipped: Story = { args: { state: "skipped" } };
export const StateExhausted: Story = { args: { state: "exhausted" } };
export const StateNeedsVerification: Story = { args: { state: "needs_verification" } };
export const StateCanceled: Story = { args: { state: "canceled" } };
export const StateStale: Story = { args: { state: "stale" } };

// Adding a new Stage / StageState breaks compile here unless a story is
// added above. This mirrors `every-stage-state-has-badge.test.tsx` so the
// Storybook surface stays in lockstep with the runtime parity test.
const _stageStories: Record<Stage, Story> = {
  discover: StageDiscover,
  enrich: StageEnrich,
  score: StageScore,
  tailor: StageTailor,
  cover: StageCover,
  apply: StageApply,
};
const _stateStories: Record<StageState, Story> = {
  pending: StatePending,
  queued: StateQueued,
  running: StateRunning,
  succeeded: StateSucceeded,
  failed: StateFailed,
  blocked: StateBlocked,
  skipped: StateSkipped,
  exhausted: StateExhausted,
  needs_verification: StateNeedsVerification,
  canceled: StateCanceled,
  stale: StateStale,
};
void _stageStories;
void _stateStories;
