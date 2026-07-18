import { fireEvent, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DemoFeatureFlagAdapter } from "../../../demo/ports.js";
import { makeOutreachThreadResponse } from "../../../test/fixtures/outreach.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { SendLogForm } from "./send-log-form.js";

describe("<SendLogForm>", () => {
  it("fails closed in the public demo before recording personal communication activity", () => {
    const logOutreachSend = vi.fn();
    const ports = buildTestPorts({ api: { logOutreachSend } });
    ports.featureFlags = new DemoFeatureFlagAdapter();
    const view = renderWithProviders(
      <SendLogForm
        threadId="thread-1"
        contactId="contact-1"
        draftId="draft-2"
      />,
      { ports },
    );

    const submit = view.getByRole("button", { name: "Record send" });
    expect(view.getByRole("combobox", { name: "Channel" })).toBeDisabled();
    expect(view.getByLabelText("Date you sent it")).toBeDisabled();
    expect(submit).toBeDisabled();
    expect(submit).toHaveAccessibleDescription(
      /Send logging is available in the local app.*does not record your personal communication activity/i,
    );
    fireEvent.submit(view.container.querySelector("form")!);
    expect(logOutreachSend).not.toHaveBeenCalled();
  });

  it("submits a controlled channel label, never free text", async () => {
    const user = userEvent.setup();
    const logOutreachSend = vi.fn(async () => makeOutreachThreadResponse());
    const ports = buildTestPorts({ api: { logOutreachSend } });
    const view = renderWithProviders(
      <SendLogForm
        threadId="thread-1"
        contactId="contact-1"
        draftId="draft-2"
      />,
      { ports },
    );

    await user.click(view.getByRole("combobox", { name: "Channel" }));
    await user.click(
      await view.findByRole("option", { name: "LinkedIn message" }),
    );
    fireEvent.change(view.getByLabelText("Date you sent it"), {
      target: { value: "2026-07-07" },
    });
    fireEvent.click(view.getByRole("button", { name: "Record send" }));

    await waitFor(() =>
      expect(logOutreachSend).toHaveBeenCalledWith("thread-1", {
        draftId: "draft-2",
        channel: "linkedin_message",
        sentAt: "2026-07-07",
      }),
    );
  });
});
