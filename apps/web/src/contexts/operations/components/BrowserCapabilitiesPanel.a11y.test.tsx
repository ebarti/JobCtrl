import { screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { BrowserCapabilitiesPanel } from "./BrowserCapabilitiesPanel.js";

describe("Browser capabilities a11y", () => {
  it("has no axe violations", async () => {
    const view = renderWithProviders(<BrowserCapabilitiesPanel />);
    await screen.findByText("Core managed browser");
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
