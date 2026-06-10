import type { Meta, StoryObj } from "@storybook/react-vite";

import { Checkbox } from "./checkbox.js";
import { Label } from "./label.js";

const meta = {
  title: "Shared/UI/Checkbox",
  component: Checkbox,
  args: {
    "aria-label": "Sample checkbox",
  },
} satisfies Meta<typeof Checkbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Checked: Story = {
  args: { defaultChecked: true },
};

export const Disabled: Story = {
  args: { disabled: true },
};

export const DisabledChecked: Story = {
  args: { defaultChecked: true, disabled: true, "aria-label": "Disabled checked checkbox" },
};

export const WithLabel: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Checkbox id="story-checkbox-label" />
      <Label htmlFor="story-checkbox-label">Enable compact density</Label>
    </div>
  ),
};

export const FocusVisible: Story = {
  args: { autoFocus: true, "aria-label": "Focused checkbox" },
};
