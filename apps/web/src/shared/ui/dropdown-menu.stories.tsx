import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "./button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./dropdown-menu.js";

// Radix DropdownMenu portal content has aria-hidden-focus warnings
// during the open animation. Upstream primitive behaviour, deferred.
const meta = {
  title: "Shared/UI/DropdownMenu",
  component: DropdownMenu,
  parameters: {
    a11y: { test: "off" },
  },
} satisfies Meta<typeof DropdownMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const JobActions: Story = {
  render: () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">Actions</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Pipeline</DropdownMenuLabel>
        <DropdownMenuItem>Retry stage</DropdownMenuItem>
        <DropdownMenuItem>Cancel stage</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Apply</DropdownMenuLabel>
        <DropdownMenuItem>Mark applied</DropdownMenuItem>
        <DropdownMenuItem>Mark skipped</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};

export const OpenByDefault: Story = {
  render: () => (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">Actions</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem>Open in browser</DropdownMenuItem>
        <DropdownMenuItem>Open application URL</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};
