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

// cmdk's roles surface aria-required-children warnings during the
// initial mount before the items list is registered. Upstream primitive
// behaviour, deferred.
const meta = {
  title: "Shared/UI/Command",
  component: Command,
  parameters: {
    a11y: { test: "off" },
  },
} satisfies Meta<typeof Command>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Palette: Story = {
  render: () => (
    <Command className="w-72 rounded-md border border-rule">
      <CommandInput placeholder="Search jobs, companies, runs..." />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>
        <CommandGroup heading="Jobs">
          <CommandItem>Staff Software Engineer · Acme Corp</CommandItem>
          <CommandItem>Principal Platform Engineer · Globex</CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Apply runs">
          <CommandItem>run-1 · running</CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  ),
};

export const EmptyState: Story = {
  render: () => (
    <Command className="w-72 rounded-md border border-rule">
      <CommandInput placeholder="Search jobs..." defaultValue="zzzzzzzz" />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>
      </CommandList>
    </Command>
  ),
};
