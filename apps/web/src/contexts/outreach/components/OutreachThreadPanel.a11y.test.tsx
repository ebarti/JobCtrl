import { axe } from "jest-axe";
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { OutreachThreadPanel } from "./OutreachThreadPanel.js";

describe("<OutreachThreadPanel> a11y", () => {
  it("renders the draft review surface from MSW with no critical axe violations", async () => {
    const view = renderWithProviders(<OutreachThreadPanel contactId="contact-1" />);
    await waitFor(() =>
      expect(view.getByRole("heading", { name: "Approved message" })).toBeInTheDocument(),
    );
    const results = await axe(view.container);
    expect(results).toHaveNoViolations();
  });
});
