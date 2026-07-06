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

const meta = {
  title: "Shared/UI/DropdownMenu",
  component: DropdownMenu,
} satisfies Meta<typeof DropdownMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Actions: Story = {
  render: () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">Actions</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" aria-label="Workspace actions">
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
  parameters: {
    a11y: { element: '[role="menu"][data-state="open"]' },
  },
  render: () => (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">Actions</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" aria-label="Open menu actions">
        <DropdownMenuLabel>Open menu</DropdownMenuLabel>
        <DropdownMenuItem>Rename item</DropdownMenuItem>
        <DropdownMenuCheckboxItem checked>Selected option</DropdownMenuCheckboxItem>
        <DropdownMenuItem disabled>Disabled option</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};
