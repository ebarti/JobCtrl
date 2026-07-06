import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import { makeGateResultsBlocked } from "../../../test/fixtures/outreach.js";
import { renderWithProviders } from "../../../test/render.js";
import { DraftGateResultsPanel } from "./DraftGateResultsPanel.js";

describe("<DraftGateResultsPanel> a11y", () => {
  it("renders a blocked gate with every failing field and no critical axe violations", async () => {
    const view = renderWithProviders(
      <DraftGateResultsPanel gateResults={makeGateResultsBlocked()} />,
    );
    expect(view.getByText("Truthfulness gates blocked this draft")).toBeInTheDocument();
    const results = await axe(view.container);
    expect(results).toHaveNoViolations();
  });
});
