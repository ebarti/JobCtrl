import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";

import { sampleDashboardSummary } from "../../test/fixtures/projections.js";
import { ActivityDetailDrawer } from "./ActivityDetailDrawer.js";

const meta = {
  title: "Views/Dashboard/ActivityDetailDrawer",
  component: ActivityDetailDrawer,
  parameters: {
    withRouter: true,
    initialPath: "/activity/evt-1",
  },
  args: {
    eventId: "evt-1",
  },
} satisfies Meta<typeof ActivityDetailDrawer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

export const NotFound: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/dashboard/summary", () =>
          HttpResponse.json({ ...sampleDashboardSummary, activity: [] }),
        ),
      ],
    },
  },
};
