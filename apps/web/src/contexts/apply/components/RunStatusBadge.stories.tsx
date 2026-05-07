import type { Meta, StoryObj } from "@storybook/react-vite";
import type { WorkflowRunStatus } from "@jobhunter/contracts";

import { RunStatusBadge } from "./RunStatusBadge.js";

const meta = {
  title: "Contexts/Apply/RunStatusBadge",
  component: RunStatusBadge,
} satisfies Meta<typeof RunStatusBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Starting: Story = { args: { status: "starting" } };
export const InProgress: Story = { args: { status: "in_progress" } };
export const Succeeded: Story = { args: { status: "succeeded" } };
export const Failed: Story = { args: { status: "failed" } };
export const Canceled: Story = { args: { status: "canceled" } };
export const Terminated: Story = { args: { status: "terminated" } };
export const TimedOut: Story = { args: { status: "timed_out" } };
export const DryRunComplete: Story = { args: { status: "dry_run_complete" } };
export const Captcha: Story = { args: { status: "captcha" } };
export const LoginIssue: Story = { args: { status: "login_issue" } };
export const Expired: Story = { args: { status: "expired" } };
export const Manual: Story = { args: { status: "manual" } };

// Adding a new WorkflowRunStatus value breaks compile here unless a story is
// added above. The per-discriminant-arm pattern from ApplyRunBadge.stories.tsx.
const _statusStories: Record<WorkflowRunStatus, Story> = {
  starting: Starting,
  in_progress: InProgress,
  succeeded: Succeeded,
  failed: Failed,
  canceled: Canceled,
  terminated: Terminated,
  timed_out: TimedOut,
  dry_run_complete: DryRunComplete,
  captcha: Captcha,
  login_issue: LoginIssue,
  expired: Expired,
  manual: Manual,
};
void _statusStories;
