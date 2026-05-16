import type { Meta, StoryObj } from "@storybook/react-vite";

import { PipelinesView } from "./PipelinesView.js";

const meta = {
  title: "Views/Pipelines/PipelinesView",
  component: PipelinesView,
  parameters: {
    withRouter: true,
    initialPath: "/pipelines",
  },
} satisfies Meta<typeof PipelinesView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
