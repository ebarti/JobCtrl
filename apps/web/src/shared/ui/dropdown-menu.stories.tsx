import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "./button.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
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
    // a11y deferred — Radix DropdownMenu aria-hidden-focus during open animation; see meta comment above.
    a11y: { test: "off" },
  },
} satisfies Meta<typeof DropdownMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Actions: Story = {
  render: () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">Actions</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Workspace</DropdownMenuLabel>
        <DropdownMenuItem>Open preview</DropdownMenuItem>
        <DropdownMenuItem>Duplicate item</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Display</DropdownMenuLabel>
        <DropdownMenuCheckboxItem checked>Show helper text</DropdownMenuCheckboxItem>
        <DropdownMenuItem disabled>Archive unavailable</DropdownMenuItem>
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
        <DropdownMenuLabel>Open menu</DropdownMenuLabel>
        <DropdownMenuItem>Rename item</DropdownMenuItem>
        <DropdownMenuCheckboxItem checked>Selected option</DropdownMenuCheckboxItem>
        <DropdownMenuItem disabled>Disabled option</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};
