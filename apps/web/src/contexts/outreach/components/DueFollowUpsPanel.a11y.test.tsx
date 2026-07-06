import { axe } from "jest-axe";
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { DueFollowUpsPanel } from "./DueFollowUpsPanel.js";

describe("<DueFollowUpsPanel> a11y", () => {
  it("renders the due follow-ups from MSW with no critical axe violations", async () => {
    const view = renderWithProviders(<DueFollowUpsPanel />);
    await waitFor(() =>
      expect(view.getByText("application_submitted")).toBeInTheDocument(),
    );
    const results = await axe(view.container);
    expect(results).toHaveNoViolations();
  });
});
