import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "./button.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip.js";

const meta = {
  title: "Shared/UI/Tooltip",
  component: Tooltip,
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof Tooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Hint: Story = {
  render: () => (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <Button variant="outline">Retry stage</Button>
      </TooltipTrigger>
      <TooltipContent>Re-runs from the last failed stage.</TooltipContent>
    </Tooltip>
  ),
};

export const OpenByDefault: Story = {
  render: () => (
    <Tooltip defaultOpen>
      <TooltipTrigger asChild>
        <Button variant="outline">Cancel apply</Button>
      </TooltipTrigger>
      <TooltipContent>Stops the run before submission.</TooltipContent>
    </Tooltip>
  ),
};
