import type { Meta, StoryObj } from "@storybook/react-vite";

import { SendLogForm } from "./send-log-form.js";

const meta = {
  title: "Contexts/Outreach/Forms/SendLogForm",
  component: SendLogForm,
  args: { threadId: "thread-1", contactId: "contact-1", draftId: "draft-2" },
} satisfies Meta<typeof SendLogForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const ForLinkedJob: Story = {
  args: { jobId: "https://example.com/job/1" },
};
