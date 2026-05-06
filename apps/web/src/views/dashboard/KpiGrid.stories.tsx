import type { Meta, StoryObj } from "@storybook/react-vite";

import { sampleDashboardSummary } from "../../test/fixtures/projections.js";
import { KpiGrid, KpiSkeleton } from "./KpiGrid.js";

const meta = {
  title: "Views/Dashboard/KpiGrid",
  component: KpiGrid,
  parameters: {
    withRouter: true,
    initialPath: "/dashboard",
  },
  args: {
    summary: sampleDashboardSummary,
  },
} satisfies Meta<typeof KpiGrid>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

export const ZeroState: Story = {
  args: {
    summary: {
      ...sampleDashboardSummary,
      totals: {
        jobs: 0,
        failures: 0,
        blocked: 0,
        ready: 0,
        applied: 0,
        dryRuns: 0,
      },
    },
  },
};

export const Skeleton: Story = {
  render: () => <KpiSkeleton />,
};
