import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { BrowserCapabilitiesPanel } from "./BrowserCapabilitiesPanel.js";
import { ExtensionPairingPanel } from "./ExtensionPairingPanel.js";

describe("Browser capabilities a11y", () => {
  it("has no axe violations", async () => {
    const user = userEvent.setup();
    const view = renderWithProviders(<BrowserCapabilitiesPanel />);

    const configurations = await screen.findAllByText("Configure executable path");
    await user.click(configurations[0]!);

    expect(await axe(view.container)).toHaveNoViolations();
  });

  it("keeps the extension token disclosure accessible", async () => {
    const view = renderWithProviders(<ExtensionPairingPanel />);

    expect(
      screen.getByRole("region", { name: "Browser extension pairing controls" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Copy token" })).toBeEnabled(),
    );

    expect(await axe(view.container)).toHaveNoViolations();
  });
});
