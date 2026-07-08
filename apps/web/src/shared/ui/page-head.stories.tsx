import type { Meta, StoryObj } from "@storybook/react-vite";

import { Badge } from "./badge.js";
import { Button } from "./button.js";
import { PageHead } from "./page-head.js";

const meta = {
  title: "Shared/UI/PageHead",
  component: PageHead,
} satisfies Meta<typeof PageHead>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    eyebrow: "Overview",
    title: "Dashboard",
    subtitle: "Pipeline health at a glance",
  },
};

export const WithActions: Story = {
  args: {
    eyebrow: "Pipeline",
    title: "Jobs",
    subtitle: "1,204 total",
    actions: (
      <>
        <Badge variant="outline">12 stale</Badge>
        <Button size="sm">New search</Button>
      </>
    ),
  },
};

export const TitleOnly: Story = {
  args: {
    title: "Pipelines",
  },
};

export const LongTitleAndSubtitle: Story = {
  args: {
    eyebrow: "Library",
    title: "Career evidence map",
    subtitle:
      "Every skill and achievement, traced to the resumes and requirements that used it",
  },
};
