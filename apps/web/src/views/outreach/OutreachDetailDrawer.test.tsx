import { userEvent } from "@testing-library/user-event";
import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../../test/render.js";
import { OutreachDetailDrawer } from "./OutreachDetailDrawer.js";

describe("<OutreachDetailDrawer>", () => {
  it("shows the contact's facts and composes the outreach draft review surface", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const view = renderWithProviders(
      <OutreachDetailDrawer contactId="contact-1" onClose={onClose} />,
    );
    await waitFor(() =>
      expect(view.getByRole("heading", { name: "Dana Reyes" })).toBeInTheDocument(),
    );
    expect(view.getByRole("heading", { name: "Dana Reyes" })).toHaveAttribute(
      "data-typography",
      "page-title",
    );
    // Phase 1 facts + provenance remain.
    expect(view.getByText("dana.reyes@acme.example")).toBeInTheDocument();
    // Phase 3 outreach thread panel is composed into the drawer (contact-only thread).
    await waitFor(() =>
      expect(view.getByRole("heading", { name: "Outreach" })).toBeInTheDocument(),
    );
    expect(view.getByRole("heading", { name: "Approved message" })).toBeInTheDocument();
    expect(view.getByRole("article", { name: "Contact details" })).toHaveClass(
      "route-workspace",
      "contact-detail-workspace",
    );
    expect(
      view.queryByRole("dialog", { name: "Contact details" }),
    ).not.toBeInTheDocument();

    await user.click(view.getByRole("button", { name: "Back to contacts" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
