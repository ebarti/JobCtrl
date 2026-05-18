import type { Meta, StoryObj } from "@storybook/react-vite";

import { JobDescription } from "./JobDescription.js";

const meta = {
  title: "Views/Jobs/JobDescription",
  component: JobDescription,
} satisfies Meta<typeof JobDescription>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ShortText: Story = {
  args: {
    text: "Lead the platform engineering team. Drive SRE practices and on-call ergonomics.",
  },
};

export const ManyParagraphs: Story = {
  args: {
    text: [
      "Acme Corp builds platform tooling for distributed-systems teams.",
      "You will lead the SRE chapter and partner with product leadership on reliability budgets.",
      "We invest heavily in developer experience and platform observability.",
      "Compensation is at the top of market for staff-plus engineers.",
    ].join("\n\n"),
  },
};

export const Markdown: Story = {
  args: {
    text: [
      "**Welcome to the good side of tech 👋**",
      "Build [patient-facing products](https://example.com) with a platform-as-product mindset.",
      "",
      "- Lead engineering teams",
      "- Keep 75% hands-on coding",
      "- Improve `SDLC` automation",
    ].join("\n"),
  },
};

export const Empty: Story = {
  args: { text: "" },
};
