import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { sampleProfileResponse } from "../../../test/fixtures/projections.js";
import { recordAt, type JsonRecord } from "../lib/json-record.js";
import { StructuredProfileEditor } from "./StructuredProfileEditor.js";

const meta = {
  title: "Contexts/Profile/StructuredProfileEditor",
  component: StructuredProfileEditor,
  args: {
    profile: recordAt(sampleProfileResponse, "profile"),
    style: recordAt(sampleProfileResponse, "style"),
    onProfileChange: () => {},
    onStyleChange: () => {},
  },
} satisfies Meta<typeof StructuredProfileEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

function Stateful({ profileSeed, styleSeed }: { profileSeed: JsonRecord; styleSeed: JsonRecord }) {
  const [profile, setProfile] = useState(profileSeed);
  const [style, setStyle] = useState(styleSeed);
  return (
    <StructuredProfileEditor
      profile={profile}
      style={style}
      onProfileChange={setProfile}
      onStyleChange={setStyle}
    />
  );
}

export const Populated: Story = {
  render: () => (
    <Stateful
      profileSeed={recordAt(sampleProfileResponse, "profile")}
      styleSeed={recordAt(sampleProfileResponse, "style")}
    />
  ),
};

export const IncompleteDraft: Story = {
  render: () => <Stateful profileSeed={{ personal: { full_name: "" } }} styleSeed={{}} />,
};
