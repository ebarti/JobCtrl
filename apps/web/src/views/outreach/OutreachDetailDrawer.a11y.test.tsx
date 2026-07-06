import { axe } from "jest-axe";
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../test/render.js";
import { OutreachDetailDrawer } from "./OutreachDetailDrawer.js";

describe("<OutreachDetailDrawer> a11y", () => {
  it("has no critical axe violations when populated from MSW", async () => {
    const view = renderWithProviders(
      <OutreachDetailDrawer contactId="contact-1" onClose={() => {}} />,
    );
    await waitFor(() =>
      expect(view.getByRole("heading", { name: "Dana Reyes" })).toBeInTheDocument(),
    );
    expect(view.getByText("dana.reyes@acme.example")).toBeInTheDocument();
    const results = await axe(view.container);
    expect(results).toHaveNoViolations();
  });
});
