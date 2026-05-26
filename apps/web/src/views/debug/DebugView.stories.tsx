import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";

import { makeActivityPage, sampleDashboardSummary } from "../../test/fixtures/projections.js";
import { DebugView } from "./DebugView.js";

const meta = {
  title: "Views/Debug/DebugView",
  component: DebugView,
  parameters: {
    withRouter: true,
    initialPath: "/debug",
  },
} satisfies Meta<typeof DebugView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/debug/activity", () =>
          HttpResponse.json(makeActivityPage([])),
        ),
      ],
    },
  },
};

export const Error: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/debug/activity", () =>
          HttpResponse.json({ ok: false, error: "internal" }, { status: 500 }),
        ),
      ],
    },
  },
};

export const ManyEvents: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/debug/activity", () =>
          HttpResponse.json(makeActivityPage(sampleDashboardSummary.activity, 1, 50, 7117)),
        ),
      ],
    },
  },
};
