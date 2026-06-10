import type { Meta, StoryObj } from "@storybook/react-vite";

import { Input } from "./input.js";
import { Label } from "./label.js";

const meta = {
  title: "Shared/UI/Input",
  component: Input,
  args: {
    placeholder: "Search jobs...",
  },
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithValue: Story = {
  args: { defaultValue: "platform engineer" },
};

export const Disabled: Story = {
  args: { disabled: true, placeholder: "Read-only field" },
};

export const TypePassword: Story = {
  args: { type: "password", placeholder: "API key" },
};

export const TypeNumber: Story = {
  args: { type: "number", placeholder: "Min fit score", min: 0, max: 10 },
};

export const WithLabelAndHelper: Story = {
  render: () => (
    <div className="grid w-80 gap-2">
      <Label htmlFor="story-input-name">Display name</Label>
      <Input id="story-input-name" defaultValue="Sample workspace" aria-describedby="story-input-help" />
      <p id="story-input-help" className="text-sm text-muted-foreground">
        Shown anywhere this synthetic example needs a label.
      </p>
    </div>
  ),
};

export const Invalid: Story = {
  render: () => (
    <div className="grid w-80 gap-2">
      <Label htmlFor="story-input-invalid">Short code</Label>
      <Input
        id="story-input-invalid"
        defaultValue="x"
        aria-invalid="true"
        aria-describedby="story-input-error"
        className="border-destructive focus-visible:ring-destructive"
      />
      <p id="story-input-error" className="text-sm text-destructive">
        Use at least three characters.
      </p>
    </div>
  ),
};

export const FocusVisible: Story = {
  args: {
    autoFocus: true,
    defaultValue: "Focused field",
    "aria-label": "Focused field",
  },
};
