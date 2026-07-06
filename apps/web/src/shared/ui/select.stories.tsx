import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "./select.js";

const meta = {
  title: "Shared/UI/Select",
  component: Select,
} satisfies Meta<typeof Select>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Value: Story = {
  render: () => (
    <Select defaultValue="compact">
      <SelectTrigger aria-label="View density" className="w-56">
        <SelectValue placeholder="Pick a view" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>View density</SelectLabel>
          <SelectItem value="compact">Compact</SelectItem>
          <SelectItem value="regular">Regular</SelectItem>
          <SelectItem value="comfortable">Comfortable</SelectItem>
          <SelectItem disabled value="locked">
            Locked option
          </SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  ),
};

export const OpenByDefault: Story = {
  parameters: {
    a11y: { element: '[role="listbox"][data-state="open"]' },
  },
  render: () => (
    <Select defaultOpen defaultValue="regular">
      <SelectTrigger aria-label="View density" className="w-56">
        <SelectValue placeholder="Pick a view" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>View density</SelectLabel>
          <SelectItem value="compact">Compact</SelectItem>
          <SelectItem value="regular">Regular</SelectItem>
          <SelectItem value="comfortable">Comfortable</SelectItem>
          <SelectItem disabled value="locked">
            Locked option
          </SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  ),
};

export const Disabled: Story = {
  render: () => (
    <Select disabled defaultValue="regular">
      <SelectTrigger aria-label="View density" className="w-56">
        <SelectValue placeholder="Pick a view" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="regular">Regular</SelectItem>
      </SelectContent>
    </Select>
  ),
};
