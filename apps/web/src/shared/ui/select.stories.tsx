import type { Meta, StoryObj } from "@storybook/react-vite";
import { DirectionProvider } from "@base-ui/react/direction-provider";
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

const densityItems = [
  { label: "Compact", value: "compact" },
  { label: "Regular", value: "regular" },
  { label: "Comfortable", value: "comfortable" },
  { label: "Locked option", value: "locked" },
];
const selectableDensityItems = densityItems.slice(0, 3);
const placeholderDensityItems = densityItems.slice(0, 2);
const regularDensityItems = [densityItems[1]!];
const longListItems = Array.from({ length: 30 }, (_, index) => ({
  label: `Option ${index + 1}`,
  value: `option-${index + 1}`,
}));
const accessBasisItems = [
  { label: "Public markdown", value: "public_markdown" },
  { label: "Licensed API", value: "licensed_api" },
];

function ControlledDensitySelect() {
  const [value, setValue] = useState("compact");

  return (
    <Select
      items={selectableDensityItems}
      value={value}
      onValueChange={(nextValue) => {
        if (nextValue !== null) setValue(nextValue);
      }}
    >
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
    <Select items={densityItems} defaultValue="compact">
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
    <Select items={densityItems} defaultOpen defaultValue="regular">
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
    <Select items={placeholderDensityItems}>
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
    <Select items={regularDensityItems} disabled defaultValue="regular">
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
    <DirectionProvider direction="rtl">
      <Select items={selectableDensityItems} defaultValue="regular">
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
    </DirectionProvider>
  ),
};

export const LongScrollableList: Story = {
  render: () => (
    <Select items={longListItems} defaultOpen defaultValue="option-1">
      <SelectTrigger aria-label="Long option list" className="w-56">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-48">
        <SelectGroup>
          <SelectLabel>Long option list</SelectLabel>
          {longListItems.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  ),
};

export const BaseContract: Story = {
  tags: ["select-contract"],
  render: () => (
    <Select items={accessBasisItems} defaultOpen defaultValue="licensed_api">
      <SelectTrigger aria-label="Access basis" className="w-56">
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        alignItemWithTrigger={false}
        data-testid="select-contract-popup"
      >
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
      throw new Error("Expected trigger-edge popup positioning.");
    }
    if (!group.getAttribute("aria-labelledby")) {
      throw new Error(
        "Expected SelectGroup to be associated with SelectLabel.",
      );
    }
  },
};
