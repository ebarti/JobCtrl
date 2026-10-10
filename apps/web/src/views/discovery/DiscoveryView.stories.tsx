import type { Meta, StoryObj } from "@storybook/react-vite";

import { DiscoveryView } from "./DiscoveryView.js";

const meta = {
  title: "Views/Discovery/DiscoveryView",
  component: DiscoveryView,
  tags: ["search-settings"],
  parameters: { withRouter: true, initialPath: "/discovery" },
} satisfies Meta<typeof DiscoveryView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
