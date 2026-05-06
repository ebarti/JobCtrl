import type { Meta, StoryObj } from "@storybook/react-vite";

import { sampleSettingsResponse } from "../../../test/fixtures/projections.js";
import { SettingsForm } from "./settings-form.js";

const meta = {
  title: "Contexts/Profile/Forms/SettingsForm",
  component: SettingsForm,
  args: {
    initial: sampleSettingsResponse.settings,
  },
} satisfies Meta<typeof SettingsForm>;

export default meta;
type Story = StoryObj<typeof meta>;

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
