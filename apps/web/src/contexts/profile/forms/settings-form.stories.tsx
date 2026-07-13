import type { Meta, StoryObj } from "@storybook/react-vite";

import { sampleSettingsResponse } from "../../../test/fixtures/projections.js";
import { SettingsForm } from "./settings-form.js";

const meta = {
  title: "Contexts/Profile/Forms/SettingsForm",
  component: SettingsForm,
  args: {
    initial: sampleSettingsResponse.settings,
    effectiveSettings: sampleSettingsResponse.effectiveSettings,
    activeWorkerActivitySlots: 4,
    workerStatus: "healthy",
  },
} satisfies Meta<typeof SettingsForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const HigherConcurrency: Story = {
  args: {
    initial: { ...sampleSettingsResponse.settings, applyConcurrency: 4 },
  },
};

export const UnlimitedBudget: Story = {
  args: {
    initial: { ...sampleSettingsResponse.settings, dailyBudgetUsd: 0 },
  },
};
