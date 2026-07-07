import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ApplyRunStatus } from "@jobctrl/domain-types";

import { ApplyRunBadge } from "./ApplyRunBadge.js";

const meta = {
  title: "Contexts/Apply/ApplyRunBadge",
  component: ApplyRunBadge,
} satisfies Meta<typeof ApplyRunBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Starting: Story = { args: { result: "starting" } };
export const InProgress: Story = { args: { result: "in_progress" } };
export const Succeeded: Story = { args: { result: "succeeded" } };
export const Failed: Story = { args: { result: "failed" } };
export const Captcha: Story = { args: { result: "captcha" } };
export const LoginIssue: Story = { args: { result: "login_issue" } };
export const Expired: Story = { args: { result: "expired" } };
export const Manual: Story = { args: { result: "manual" } };
export const DryRunComplete: Story = { args: { result: "dry_run_complete" } };

// Adding a new ApplyRunStatus value breaks compile here unless a story is
// added above. This is the per-storybook analogue of the operations parity
// guards.
const _statusStories: Record<ApplyRunStatus, Story> = {
  starting: Starting,
  in_progress: InProgress,
  succeeded: Succeeded,
  failed: Failed,
  captcha: Captcha,
  login_issue: LoginIssue,
  expired: Expired,
  manual: Manual,
  dry_run_complete: DryRunComplete,
};
void _statusStories;
