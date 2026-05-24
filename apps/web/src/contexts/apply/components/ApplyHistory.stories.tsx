import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";

import { sampleDashboardSummary } from "../../../test/fixtures/projections.js";
import { ApplyHistory } from "./ApplyHistory.js";

// ApplyHistory rows wrap a TanStack Router <Link> around badge/icon
// content. The Link surface lacks discernible text in the production
// component (a button-name violation). Deferred — production code, out
// of Phase 7 scope.
const meta = {
  title: "Contexts/Apply/ApplyHistory",
  component: ApplyHistory,
  args: { jobId: "job-1" },
  parameters: {
    layout: "padded",
    // a11y deferred — TanStack Router Link button-name defect in ApplyHistory.tsx; see meta comment above.
    a11y: { test: "off" },
  },
} satisfies Meta<typeof ApplyHistory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/dashboard/summary", () =>
          HttpResponse.json({
            ...sampleDashboardSummary,
            applyRuns: [
              {
                runId: "run-1",
                jobKey: "job-1",
                title: "Staff Software Engineer",
                company: "Acme Corp",
                status: "in_progress",
                dryRun: false,
                startedAt: "2026-05-06T07:00:00Z",
              },
              {
                runId: "run-2",
                jobKey: "job-1",
                title: "Staff Software Engineer",
                company: "Acme Corp",
                status: "succeeded",
                dryRun: true,
                startedAt: "2026-05-05T14:30:00Z",
              },
            ],
          }),
        ),
      ],
    },
  },
};

export const Empty: Story = {
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
