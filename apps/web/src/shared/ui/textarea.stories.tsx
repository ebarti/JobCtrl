import type { Meta, StoryObj } from "@storybook/react-vite";

import { Label } from "./label.js";
import { Textarea } from "./textarea.js";

const meta = {
  title: "Shared/UI/Textarea",
  component: Textarea,
  args: {
    placeholder: "Score reasoning...",
    rows: 4,
  },
} satisfies Meta<typeof Textarea>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithValue: Story = {
  args: {
    defaultValue: "Strong fit on platform reliability and SRE leadership.",
  },
};

export const Disabled: Story = {
  args: { disabled: true, defaultValue: "Read-only" },
};

export const WithLabelAndHelper: Story = {
  render: () => (
    <div className="grid w-96 gap-2">
      <Label htmlFor="story-textarea-note">Review note</Label>
      <Textarea
        id="story-textarea-note"
        rows={4}
        defaultValue="Synthetic explanation text for a multiline primitive state."
        aria-describedby="story-textarea-help"
      />
      <p id="story-textarea-help" className="text-sm text-muted-foreground">
        Keep helper copy concise and generic.
      </p>
    </div>
  ),
};

export const Invalid: Story = {
  render: () => (
    <div className="grid w-96 gap-2">
      <Label htmlFor="story-textarea-invalid">Reason</Label>
      <Textarea
        id="story-textarea-invalid"
        rows={4}
        defaultValue=""
        aria-invalid="true"
        aria-describedby="story-textarea-error"
        className="border-destructive focus-visible:ring-destructive"
        placeholder="Add a short reason..."
      />
      <p id="story-textarea-error" className="text-sm text-destructive">
        Enter a reason before continuing.
      </p>
    </div>
  ),
};

export const FocusVisible: Story = {
  args: {
    autoFocus: true,
    defaultValue: "Focused multiline field",
    "aria-label": "Focused multiline field",
  },
};
