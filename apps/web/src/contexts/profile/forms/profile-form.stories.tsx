import type { Meta, StoryObj } from "@storybook/react-vite";

import { sampleProfileResponse } from "../../../test/fixtures/projections.js";
import { ProfileForm } from "./profile-form.js";

const meta = {
  title: "Contexts/Profile/Forms/ProfileForm",
  component: ProfileForm,
  parameters: {
    withRouter: true,
    initialPath: "/profile",
  },
  args: {
    initial: sampleProfileResponse,
  },
} satisfies Meta<typeof ProfileForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

export const MinimalProfile: Story = {
  args: {
    initial: {
      ok: true,
      profile: {
        personal: { full_name: "" },
      },
      style: { font_family: "moderncv" },
      templateText: "",
    },
  },
};
