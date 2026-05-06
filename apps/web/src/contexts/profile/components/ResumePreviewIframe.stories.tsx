import type { Meta, StoryObj } from "@storybook/react-vite";

import { ResumePreviewIframe } from "./ResumePreviewIframe.js";

const meta = {
  title: "Contexts/Profile/ResumePreviewIframe",
  component: ResumePreviewIframe,
} satisfies Meta<typeof ResumePreviewIframe>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
