import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { server } from "../../../test/msw/server.js";
import { renderWithProviders } from "../../../test/render.js";
import { DueFollowUpsPanel } from "./DueFollowUpsPanel.js";

describe("<DueFollowUpsPanel>", () => {
  it("lists the due follow-ups from the read model", async () => {
    const view = renderWithProviders(<DueFollowUpsPanel />);
    await waitFor(() =>
      expect(view.getByText("https://example.com/job/1")).toBeInTheDocument(),
    );
    expect(
      view.getByText(/Reminders surfaced for you to act on/i).parentElement,
    ).toHaveClass("outreach-due-follow-ups-content");
    expect(view.getByText("application_submitted")).toBeInTheDocument();
    expect(view.getByText("Due")).toHaveAttribute("data-status-tone", "warn");
  });

  it("shows an empty message when nothing is due", async () => {
    server.use(
      http.get("*/v1/outreach/follow-ups/due", () =>
        HttpResponse.json({ ok: true, followUps: [] }),
      ),
    );
    const view = renderWithProviders(<DueFollowUpsPanel />);
    await waitFor(() => expect(view.getByText("No follow-ups due.")).toBeInTheDocument());
  });

  it("surfaces an error banner when the request fails", async () => {
    server.use(
      http.get("*/v1/outreach/follow-ups/due", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const view = renderWithProviders(<DueFollowUpsPanel />);
    await waitFor(() => expect(view.container.querySelector(".banner")).toBeInTheDocument());
  });
});
