import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";

import { makeDueFollowUpSummary } from "../../../test/fixtures/outreach.js";
import { DueFollowUpsBadge } from "./DueFollowUpsBadge.js";

const meta = {
  title: "Contexts/Outreach/DueFollowUpsBadge",
  component: DueFollowUpsBadge,
} satisfies Meta<typeof DueFollowUpsBadge>;

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

export const Due: Story = {
  parameters: dueHandlers([
    makeDueFollowUpSummary(),
    makeDueFollowUpSummary({ threadId: "thread-2", contactId: "contact-2" }),
  ]),
};

// Nothing due — the badge renders nothing.
export const None: Story = {
  parameters: dueHandlers([makeDueFollowUpSummary({ isDue: false })]),
};
