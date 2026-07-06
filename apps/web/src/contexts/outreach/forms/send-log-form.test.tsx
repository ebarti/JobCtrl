import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { makeOutreachThreadResponse } from "../../../test/fixtures/outreach.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { SendLogForm } from "./send-log-form.js";

describe("<SendLogForm>", () => {
  it("submits a controlled channel label, never free text", async () => {
    const logOutreachSend = vi.fn(async () => makeOutreachThreadResponse());
    const ports = buildTestPorts({ api: { logOutreachSend } });
    const view = renderWithProviders(
      <SendLogForm threadId="thread-1" contactId="contact-1" draftId="draft-2" />,
      { ports },
    );

    fireEvent.change(view.getByLabelText("Channel"), {
      target: { value: "linkedin_message" },
    });
    fireEvent.change(view.getByLabelText("Date you sent it"), {
      target: { value: "2026-07-07" },
    });
    fireEvent.click(view.getByRole("button", { name: "record send" }));

    await waitFor(() =>
      expect(logOutreachSend).toHaveBeenCalledWith("thread-1", {
        draftId: "draft-2",
        channel: "linkedin_message",
        sentAt: "2026-07-07",
      }),
    );
  });
});
