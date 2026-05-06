import type { Meta, StoryObj } from "@storybook/react-vite";

import { sampleDashboardSummary } from "../../test/fixtures/projections.js";
import { Funnel } from "./Funnel.js";

const meta = {
  title: "Views/Dashboard/Funnel",
  component: Funnel,
  parameters: {
    withRouter: true,
    initialPath: "/dashboard",
  },
  args: {
    summary: sampleDashboardSummary,
  },
} satisfies Meta<typeof Funnel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

export const Empty: Story = {
  args: {
    summary: { ...sampleDashboardSummary, funnel: [] },
  },
};
