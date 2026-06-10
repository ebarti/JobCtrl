import type { Meta, StoryObj } from "@storybook/react-vite";

import { Label } from "./label.js";
import { Switch } from "./switch.js";

const meta = {
  title: "Shared/UI/Switch",
  component: Switch,
  args: {
    "aria-label": "Sample switch",
  },
} satisfies Meta<typeof Switch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Off: Story = {};

export const On: Story = {
  args: { defaultChecked: true },
};

export const Disabled: Story = {
  args: { disabled: true, defaultChecked: true },
};

export const DisabledOff: Story = {
  args: { disabled: true, "aria-label": "Disabled off switch" },
};

export const WithLabel: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <Switch id="story-switch-label" />
      <Label htmlFor="story-switch-label">Show helper text</Label>
    </div>
  ),
};

export const FocusVisible: Story = {
  args: { autoFocus: true, "aria-label": "Focused switch" },
};
