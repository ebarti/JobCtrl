import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";

import { makeDueFollowUpSummary } from "../../../test/fixtures/outreach.js";
import { DueFollowUpsPanel } from "./DueFollowUpsPanel.js";

const meta = {
  title: "Contexts/Outreach/DueFollowUpsPanel",
  component: DueFollowUpsPanel,
} satisfies Meta<typeof DueFollowUpsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

function dueHandlers(followUps: ReturnType<typeof makeDueFollowUpSummary>[]) {
  return {
    msw: {
      handlers: [
        http.get("*/v1/outreach/follow-ups/due", () =>
          HttpResponse.json({ ok: true, followUps }),
        ),
      ],
    },
  };
}

export const Populated: Story = {
  parameters: dueHandlers([
    makeDueFollowUpSummary(),
    makeDueFollowUpSummary({
      threadId: "thread-2",
      contactId: "contact-2",
      jobId: null,
      basis: "no_reply_nudge",
      dueAt: "2026-07-20T00:00:00+00:00",
      isDue: false,
    }),
  ]),
};

export const Empty: Story = {
  parameters: dueHandlers([]),
};

export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/outreach/follow-ups/due", async () => {
          await new Promise((resolve) => setTimeout(resolve, 60_000));
          return HttpResponse.json({ ok: true, followUps: [] });
        }),
      ],
    },
  },
};
