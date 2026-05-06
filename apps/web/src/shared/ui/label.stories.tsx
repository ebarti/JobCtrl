import type { Meta, StoryObj } from "@storybook/react-vite";

import { Input } from "./input.js";
import { Label } from "./label.js";

const meta = {
  title: "Shared/UI/Label",
  component: Label,
  args: {
    children: "Min fit score",
  },
} satisfies Meta<typeof Label>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithInput: Story = {
  render: () => (
    <div className="grid gap-2">
      <Label htmlFor="story-min-fit">Min fit score</Label>
      <Input id="story-min-fit" type="number" min={0} max={10} defaultValue={7} />
    </div>
  ),
};
