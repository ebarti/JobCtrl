import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";

import { sampleDashboardSummary } from "../../test/fixtures/projections.js";
import { ApplyRunDrawer } from "./ApplyRunDrawer.js";

const meta = {
  title: "Views/Dashboard/ApplyRunDrawer",
  component: ApplyRunDrawer,
  parameters: {
    withRouter: true,
    initialPath: "/runs/run-1",
  },
  args: {
    runId: "run-1",
  },
} satisfies Meta<typeof ApplyRunDrawer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

export const NotFound: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/dashboard/summary", () =>
          HttpResponse.json({ ...sampleDashboardSummary, applyRuns: [] }),
        ),
      ],
    },
  },
};

export const Error: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/dashboard/summary", () =>
          HttpResponse.json({ ok: false, error: "internal" }, { status: 500 }),
        ),
      ],
    },
  },
};
