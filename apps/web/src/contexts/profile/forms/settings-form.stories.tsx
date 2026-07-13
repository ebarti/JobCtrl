import type { Meta, StoryObj } from "@storybook/react-vite";

import { sampleSettingsResponse } from "../../../test/fixtures/projections.js";
import { DiscoveryAutomationSettingsForm, SettingsForm } from "./settings-form.js";

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
type DiscoveryAutomationStory = StoryObj<typeof DiscoveryAutomationSettingsForm>;

export const Default: Story = {};

export const AutoApplyOn: Story = {
  args: {
    initial: { ...sampleSettingsResponse.settings, autoApply: true, applyConcurrency: 4 },
  },
};

export const ZeroFitMin: Story = {
  args: {
    initial: { ...sampleSettingsResponse.settings, minFitScore: 0 },
  },
};

export const DiscoveryAutomationDefault: DiscoveryAutomationStory = {
  render: (args) => <DiscoveryAutomationSettingsForm {...args} />,
  args: {
    initial: sampleSettingsResponse.settings,
  },
};

export const DiscoveryAutomationAutonomous: DiscoveryAutomationStory = {
  render: (args) => <DiscoveryAutomationSettingsForm {...args} />,
  args: {
    initial: {
      ...sampleSettingsResponse.settings,
      autoApply: true,
      applyApprovalRequired: false,
    },
  },
};
