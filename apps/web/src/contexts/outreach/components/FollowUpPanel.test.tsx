import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { makeOutreachFollowUp, makeOutreachThreadResponse } from "../../../test/fixtures/outreach.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { renderWithProviders } from "../../../test/render.js";
import { FollowUpPanel } from "./FollowUpPanel.js";

describe("<FollowUpPanel>", () => {
  it("makes clear a follow-up is a surfaced-only reminder that never sends (INV-1)", () => {
    const view = renderWithProviders(
      <FollowUpPanel threadId="thread-1" contactId="contact-1" followUp={null} />,
    );
    expect(view.getByText(/JobHunter never sends it or acts on it/i)).toBeInTheDocument();
  });

  it("schedules from the server-derived application lifecycle when no custom date is entered", async () => {
    const scheduleOutreachFollowUp = vi.fn(async () =>
      makeOutreachThreadResponse(),
    );
    const ports = buildTestPorts({ api: { scheduleOutreachFollowUp } });
    const view = renderWithProviders(
      <FollowUpPanel threadId="thread-1" contactId="contact-1" followUp={null} />,
      { ports },
    );
    fireEvent.click(view.getByRole("button", { name: "schedule follow-up" }));
    await waitFor(() =>
      expect(scheduleOutreachFollowUp).toHaveBeenCalledWith("thread-1", {}),
    );
  });

  it("posts a manually edited due date as an override", async () => {
    const scheduleOutreachFollowUp = vi.fn(async () =>
      makeOutreachThreadResponse(),
    );
    const ports = buildTestPorts({ api: { scheduleOutreachFollowUp } });
    const view = renderWithProviders(
      <FollowUpPanel threadId="thread-1" contactId="contact-1" followUp={null} />,
      { ports },
    );
    fireEvent.change(view.getByLabelText("Remind me on"), { target: { value: "2026-08-01" } });
    fireEvent.click(view.getByRole("button", { name: "schedule follow-up" }));
    await waitFor(() =>
      expect(scheduleOutreachFollowUp).toHaveBeenCalledWith("thread-1", { dueAt: "2026-08-01" }),
    );
  });

  it("shows the scheduled reminder with mark-done and dismiss actions", async () => {
    const completeOutreachFollowUp = vi.fn(async () => makeOutreachThreadResponse());
    const dismissOutreachFollowUp = vi.fn(async () => makeOutreachThreadResponse());
    const ports = buildTestPorts({ api: { completeOutreachFollowUp, dismissOutreachFollowUp } });
    const view = renderWithProviders(
      <FollowUpPanel
        threadId="thread-1"
        contactId="contact-1"
        followUp={makeOutreachFollowUp({ state: "scheduled", basis: "application_submitted" })}
      />,
      { ports },
    );
    expect(view.getByText(/application_submitted/)).toBeInTheDocument();
    fireEvent.click(view.getByRole("button", { name: "mark done" }));
    await waitFor(() => expect(completeOutreachFollowUp).toHaveBeenCalledWith("thread-1"));
    fireEvent.click(view.getByRole("button", { name: "dismiss" }));
    await waitFor(() => expect(dismissOutreachFollowUp).toHaveBeenCalledWith("thread-1"));
  });

  it("lets the user schedule a new reminder after a prior follow-up completed", () => {
    const view = renderWithProviders(
      <FollowUpPanel
        threadId="thread-1"
        contactId="contact-1"
        followUp={makeOutreachFollowUp({ state: "completed" })}
      />,
    );
    expect(view.getByText(/Last follow-up completed/i)).toBeInTheDocument();
    expect(view.getByRole("button", { name: "schedule follow-up" })).toBeInTheDocument();
  });
});
