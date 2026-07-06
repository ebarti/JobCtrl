import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";

import {
  makeCandidateThread,
  makeOutreachDraft,
  makeOutreachThreadDetail,
  makeOutreachThreadResponse,
  makeRejectedCandidateThread,
} from "../../../test/fixtures/outreach.js";
import { OutreachThreadPanel } from "./OutreachThreadPanel.js";

const meta = {
  title: "Contexts/Outreach/OutreachThreadPanel",
  component: OutreachThreadPanel,
  args: { contactId: "contact-1" },
} satisfies Meta<typeof OutreachThreadPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

function outreachHandlers(response: ReturnType<typeof makeOutreachThreadResponse>) {
  return {
    msw: {
      handlers: [http.get("*/v1/contacts/:contactId/outreach", () => HttpResponse.json(response))],
    },
  };
}

export const Empty: Story = {
  parameters: outreachHandlers(makeOutreachThreadResponse(null)),
};

export const Candidate: Story = {
  parameters: outreachHandlers(makeOutreachThreadResponse(makeCandidateThread())),
};

export const Approved: Story = {
  parameters: outreachHandlers(
    makeOutreachThreadResponse(
      makeOutreachThreadDetail({
        drafts: [
          makeOutreachDraft({ draftId: "draft-1", generation: 1, status: "superseded" }),
          makeOutreachDraft({
            draftId: "draft-2",
            generation: 2,
            status: "approved",
            approvedAt: "2026-07-06T00:05:00+00:00",
          }),
        ],
      }),
    ),
  ),
};

export const Rejected: Story = {
  parameters: outreachHandlers(makeOutreachThreadResponse(makeRejectedCandidateThread())),
};

// Full INV-5 thread: a superseded prior generation retained in history alongside
// the current approved draft and a fresh candidate under review.
export const Superseded: Story = {
  parameters: outreachHandlers(makeOutreachThreadResponse(makeOutreachThreadDetail())),
};
