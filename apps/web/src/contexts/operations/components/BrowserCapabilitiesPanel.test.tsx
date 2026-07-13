import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { BrowserCapabilitiesPanel } from "./BrowserCapabilitiesPanel.js";

describe("<BrowserCapabilitiesPanel>", () => {
  it("offers only explicit adoption and keeps the managed browser read-only", async () => {
    renderWithProviders(<BrowserCapabilitiesPanel />);

    expect(await screen.findByText("Core managed browser")).toBeInTheDocument();
    expect(screen.getByText(/never auto-detects or adopts Chrome/i)).toBeInTheDocument();
    expect(screen.getAllByText(/status API does not echo local paths/i)).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /download/i })).not.toBeInTheDocument();
  });
});
