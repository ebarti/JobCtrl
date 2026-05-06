import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { Editor } from "./Editor.js";

const meta = {
  title: "Contexts/Profile/Editor",
  component: Editor,
  args: {
    label: "Profile JSON",
    value: '{\n  "personal": { "full_name": "Jordan Candidate" }\n}',
    saving: false,
    dirty: false,
    onChange: () => {},
    onDiscard: () => {},
    onSave: () => {},
  },
} satisfies Meta<typeof Editor>;

export default meta;
type Story = StoryObj<typeof meta>;

function Stateful({
  initial,
  saving,
}: {
  initial: string;
  saving: boolean;
}) {
  const [value, setValue] = useState(initial);
  const [dirty, setDirty] = useState(false);
  return (
    <Editor
      label="Profile JSON"
      value={value}
      saving={saving}
      dirty={dirty}
      onChange={(next) => {
        setValue(next);
        setDirty(next !== initial);
      }}
      onSave={() => setDirty(false)}
      onDiscard={() => {
        setValue(initial);
        setDirty(false);
      }}
    />
  );
}

export const Pristine: Story = {
  render: () => (
    <Stateful initial='{\n  "personal": { "full_name": "Jordan Candidate" }\n}' saving={false} />
  ),
};

export const SavingPending: Story = {
  args: { dirty: true, saving: true },
};
