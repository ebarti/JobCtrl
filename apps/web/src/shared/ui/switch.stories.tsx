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

export const WithLabel: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <Switch id="story-dry-run" />
      <Label htmlFor="story-dry-run">Dry-run apply</Label>
    </div>
  ),
};
