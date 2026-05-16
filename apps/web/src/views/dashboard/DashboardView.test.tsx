import { screen, waitForElementToBeRemoved } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../test/render.js";
import { DashboardView } from "./DashboardView.js";

describe("DashboardView", () => {
  it("does not render pipeline action controls", async () => {
    renderWithProviders(<DashboardView />);

    const loading = screen.queryByText("Loading dashboard.");
    if (loading) {
      await waitForElementToBeRemoved(loading);
    }

    expect(screen.queryByRole("heading", { name: "Pipeline actions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Discovery controls" })).not.toBeInTheDocument();
  });
});
