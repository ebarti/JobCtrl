import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "./command.js";

const meta = {
  title: "Shared/UI/Command",
  component: Command,
} satisfies Meta<typeof Command>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Palette: Story = {
  render: () => (
    <Command className="w-72 rounded-md border border-border" label="Command palette">
      <CommandInput placeholder="Search commands..." />
      <CommandList>
        <CommandEmpty>Nothing to show yet.</CommandEmpty>
        <CommandGroup heading="Actions">
          <CommandItem value="open-preview">Open preview</CommandItem>
          <CommandItem value="copy-link">Copy link</CommandItem>
          <CommandItem disabled value="archive-item">
            Archive unavailable
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Views">
          <CommandItem value="compact-view">Compact view</CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  ),
};

export const EmptyState: Story = {
  render: () => (
    <Command className="w-72 rounded-md border border-border" label="Command palette">
      <CommandInput placeholder="Search commands..." defaultValue="zzzzzzzz" />
      <CommandList>
        <CommandEmpty>Nothing to show yet.</CommandEmpty>
      </CommandList>
    </Command>
  ),
};
