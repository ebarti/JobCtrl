import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

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

function ControlledDensitySelect() {
  const [value, setValue] = useState("compact");

  return (
    <Select value={value} onValueChange={setValue}>
      <SelectTrigger aria-label="Controlled view density" className="w-56">
        <SelectValue placeholder="Pick a view" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>View density</SelectLabel>
          <SelectItem value="compact">Compact</SelectItem>
          <SelectItem value="regular">Regular</SelectItem>
          <SelectItem value="comfortable">Comfortable</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

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
    a11y: { element: "[data-base-ui-portal]" },
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

export const Placeholder: Story = {
  render: () => (
    <Select>
      <SelectTrigger aria-label="Unselected view density" className="w-56">
        <SelectValue placeholder="Pick a view" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value="compact">Compact</SelectItem>
          <SelectItem value="regular">Regular</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  ),
};

export const Controlled: Story = {
  render: () => <ControlledDensitySelect />,
};

export const Disabled: Story = {
  render: () => (
    <Select disabled defaultValue="regular">
      <SelectTrigger aria-label="View density" className="w-56">
        <SelectValue placeholder="Pick a view" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value="regular">Regular</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  ),
};

export const RightToLeft: Story = {
  render: () => (
    <Select dir="rtl" defaultValue="regular">
      <SelectTrigger aria-label="Right-to-left view density" className="w-56">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value="compact">Compact</SelectItem>
          <SelectItem value="regular">Regular</SelectItem>
          <SelectItem value="comfortable">Comfortable</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  ),
};

export const LongScrollableList: Story = {
  render: () => (
    <Select defaultOpen defaultValue="option-1">
      <SelectTrigger aria-label="Long option list" className="w-56">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-48">
        <SelectGroup>
          <SelectLabel>Long option list</SelectLabel>
          {Array.from({ length: 30 }, (_, index) => (
            <SelectItem key={index} value={`option-${index + 1}`}>
              Option {index + 1}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  ),
};

export const MigrationContract: Story = {
  tags: ["select-contract"],
  render: () => (
    <Select defaultOpen defaultValue="licensed_api">
      <SelectTrigger aria-label="Access basis" className="w-56">
        <SelectValue />
      </SelectTrigger>
      <SelectContent data-testid="select-contract-popup">
        <SelectGroup>
          <SelectLabel>Access basis options</SelectLabel>
          <SelectItem value="public_markdown">Public markdown</SelectItem>
          <SelectItem value="licensed_api">Licensed API</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  ),
  play: async ({ canvasElement }) => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

    const trigger = canvasElement.querySelector<HTMLElement>(
      '[role="combobox"][aria-label="Access basis"]',
    );
    const popup = document.querySelector<HTMLElement>(
      '[data-testid="select-contract-popup"]',
    );
    const listbox = popup?.querySelector<HTMLElement>('[role="listbox"]');
    const group = popup?.querySelector<HTMLElement>('[role="group"]');

    if (!trigger || !popup || !listbox || !group) {
      throw new Error("Missing Base UI Select contract parts.");
    }
    if (!trigger.textContent?.includes("Licensed API")) {
      throw new Error(
        `Expected the formatted label in the trigger, received ${trigger.textContent ?? "no text"}.`,
      );
    }
    if (popup.dataset.alignTrigger !== "false") {
      throw new Error("Expected Radix popper compatibility positioning.");
    }
    if (!group.getAttribute("aria-labelledby")) {
      throw new Error(
        "Expected SelectGroup to be associated with SelectLabel.",
      );
    }
  },
};
