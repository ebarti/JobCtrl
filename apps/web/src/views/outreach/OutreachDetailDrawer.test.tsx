import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../test/render.js";
import { OutreachDetailDrawer } from "./OutreachDetailDrawer.js";

describe("<OutreachDetailDrawer>", () => {
  it("shows the contact's facts and composes the outreach draft review surface", async () => {
    const view = renderWithProviders(
      <OutreachDetailDrawer contactId="contact-1" onClose={() => {}} />,
    );
    await waitFor(() =>
      expect(view.getByRole("heading", { name: "Dana Reyes" })).toBeInTheDocument(),
    );
    // Phase 1 facts + provenance remain.
    expect(view.getByText("dana.reyes@acme.example")).toBeInTheDocument();
    // Phase 3 outreach thread panel is composed into the drawer (contact-only thread).
    await waitFor(() =>
      expect(view.getByRole("heading", { name: "Outreach" })).toBeInTheDocument(),
    );
    expect(view.getByRole("heading", { name: "Approved message" })).toBeInTheDocument();
  });
});
