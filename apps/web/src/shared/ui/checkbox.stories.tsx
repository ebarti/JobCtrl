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

export const WithLabel: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Checkbox id="story-auto-apply" />
      <Label htmlFor="story-auto-apply">Enable auto-apply for matching jobs</Label>
    </div>
  ),
};
