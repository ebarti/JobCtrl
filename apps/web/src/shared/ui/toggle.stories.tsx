import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { Toggle } from "./toggle.js";

const meta = {
  title: "Shared/UI/Toggle",
  component: Toggle,
  args: {
    children: "Pin",
  },
} satisfies Meta<typeof Toggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Pressed: Story = {
  args: { defaultPressed: true },
};

export const Outline: Story = {
  args: { variant: "outline" },
};

export const Controlled: Story = {
  render: function ControlledToggle() {
    const [pressed, setPressed] = useState(false);

    return (
      <Toggle pressed={pressed} onPressedChange={setPressed}>
        {pressed ? "Pinned" : "Pin"}
      </Toggle>
    );
  },
};

export const Disabled: Story = {
  args: { defaultPressed: true, disabled: true },
};

export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <Toggle size="sm">Small</Toggle>
      <Toggle>Default</Toggle>
      <Toggle size="lg">Large</Toggle>
    </div>
  ),
};

export const FocusVisible: Story = {
  args: { autoFocus: true },
};
