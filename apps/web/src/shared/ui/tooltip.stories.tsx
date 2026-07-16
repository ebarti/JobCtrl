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
      <TooltipTrigger render={<Button variant="outline" />}>
        Show hint
      </TooltipTrigger>
      <TooltipContent>Explains the current synthetic action.</TooltipContent>
    </Tooltip>
  ),
};

export const OpenByDefault: Story = {
  render: () => (
    <Tooltip defaultOpen>
      <TooltipTrigger render={<Button variant="outline" />}>
        Open tooltip
      </TooltipTrigger>
      <TooltipContent>Open by default for surface-token review.</TooltipContent>
    </Tooltip>
  ),
};

export const DisabledControl: Story = {
  render: () => (
    <Tooltip defaultOpen>
      <TooltipTrigger render={<span />}>
        <Button disabled variant="outline">
          Disabled action
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        Disabled controls can still provide context.
      </TooltipContent>
    </Tooltip>
  ),
};

export const Positioned: Story = {
  render: () => (
    <Tooltip defaultOpen>
      <TooltipTrigger render={<Button variant="outline" />}>
        Positioned tooltip
      </TooltipTrigger>
      <TooltipContent
        align="start"
        alignOffset={8}
        side="bottom"
        sideOffset={12}
      >
        Position and offsets are forwarded to Base UI.
      </TooltipContent>
    </Tooltip>
  ),
};
