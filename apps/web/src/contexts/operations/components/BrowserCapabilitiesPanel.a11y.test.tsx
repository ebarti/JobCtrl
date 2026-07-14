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

    await user.click(
      await screen.findByRole("button", { name: /^Core managed browser/ }),
    );
    await user.click(screen.getByRole("button", { name: /^Auto-apply browser/ }));
    await user.click(
      screen.getByRole("button", { name: /^Authenticated LinkedIn browser/ }),
    );

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
