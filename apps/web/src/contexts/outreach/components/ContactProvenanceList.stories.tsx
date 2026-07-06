import type { Meta, StoryObj } from "@storybook/react-vite";

import { sampleContactAttributes } from "../../../test/fixtures/contacts.js";
import { ContactProvenanceList } from "./ContactProvenanceList.js";

const meta = {
  title: "Contexts/Outreach/ContactProvenanceList",
  component: ContactProvenanceList,
  args: { attributes: sampleContactAttributes },
} satisfies Meta<typeof ContactProvenanceList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

export const Empty: Story = {
  args: { attributes: [] },
};
