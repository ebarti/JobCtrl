import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { Checkbox } from "./checkbox.js";
import { Label } from "./label.js";

const meta = {
  title: "Shared/UI/Checkbox",
  component: Checkbox,
  args: {
    "aria-label": "Sample checkbox",
  },
} satisfies Meta<typeof Checkbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Checked: Story = {
  args: { defaultChecked: true },
};

export const Indeterminate: Story = {
  args: { indeterminate: true, "aria-label": "Indeterminate checkbox" },
};

export const Controlled: Story = {
  render: function ControlledCheckbox() {
    const [checked, setChecked] = useState(false);

    return (
      <Checkbox
        aria-label="Controlled checkbox"
        checked={checked}
        onCheckedChange={(nextChecked) => setChecked(nextChecked)}
      />
    );
  },
};

export const Geometry: Story = {
  tags: ["checkbox-geometry"],
  render: () => (
    <div>
      <div>
        <Checkbox aria-label="Unchecked geometry" />
      </div>
      <div>
        <Checkbox aria-label="Checked geometry" defaultChecked />
      </div>
    </div>
  ),
  play: ({ canvasElement }) => {
    for (const name of ["Unchecked geometry", "Checked geometry"]) {
      const checkbox = canvasElement.querySelector<HTMLElement>(
        `[role="checkbox"][aria-label="${name}"]`,
      );
      if (!checkbox) {
        throw new Error(`Missing ${name} checkbox.`);
      }

      const { height, width } = checkbox.getBoundingClientRect();
      if (height !== 24 || width !== 24) {
        throw new Error(
          `Expected approved 24x24 checkbox target geometry, received ${width}x${height}.`,
        );
      }
    }
  },
};

export const Disabled: Story = {
  args: { disabled: true },
};

export const DisabledChecked: Story = {
  args: {
    defaultChecked: true,
    disabled: true,
    "aria-label": "Disabled checked checkbox",
  },
};

export const WithLabel: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Checkbox id="story-checkbox-label" />
      <Label htmlFor="story-checkbox-label">Enable compact density</Label>
    </div>
  ),
};

export const FocusVisible: Story = {
  args: { autoFocus: true, "aria-label": "Focused checkbox" },
};
