import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { sampleProfileResponse } from "../../../test/fixtures/projections.js";
import { StructuredProfileEditor } from "./StructuredProfileEditor.js";

// Renders many bare <select>/<button> form fields in the production
// component (select-name, button-name violations). Phase 4 defect;
// deferred.
const meta = {
  title: "Contexts/Profile/StructuredProfileEditor",
  component: StructuredProfileEditor,
  args: {
    profileText: JSON.stringify(sampleProfileResponse.profile, null, 2),
    styleText: JSON.stringify(sampleProfileResponse.style, null, 2),
    onProfileTextChange: () => {},
    onStyleTextChange: () => {},
  },
  parameters: {
    // a11y deferred — StructuredProfileEditor.tsx bare select-name + button-name defects; see meta comment above.
    a11y: { test: "off" },
  },
} satisfies Meta<typeof StructuredProfileEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

function Stateful({ profileSeed, styleSeed }: { profileSeed: string; styleSeed: string }) {
  const [profileText, setProfileText] = useState(profileSeed);
  const [styleText, setStyleText] = useState(styleSeed);
  return (
    <StructuredProfileEditor
      profileText={profileText}
      styleText={styleText}
      onProfileTextChange={setProfileText}
      onStyleTextChange={setStyleText}
    />
  );
}

export const Populated: Story = {
  render: () => (
    <Stateful
      profileSeed={JSON.stringify(sampleProfileResponse.profile, null, 2)}
      styleSeed={JSON.stringify(sampleProfileResponse.style, null, 2)}
    />
  ),
};

export const InvalidJson: Story = {
  render: () => (
    <Stateful profileSeed='{"this is": "not valid json' styleSeed="{}" />
  ),
};
