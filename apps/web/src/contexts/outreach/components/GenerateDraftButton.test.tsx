import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DemoFeatureFlagAdapter } from "../../../demo/ports.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { GenerateDraftButton } from "./GenerateDraftButton.js";

describe("<GenerateDraftButton>", () => {
  it("fails closed in the public demo before generating a message", async () => {
    const generateOutreachDraft = vi.fn();
    const ports = buildTestPorts({ api: { generateOutreachDraft } });
    ports.featureFlags = new DemoFeatureFlagAdapter();

    renderWithProviders(<GenerateDraftButton contactId="contact-1" />, { ports });

    const button = screen.getByRole("button", { name: "Generate draft" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(
      /Draft generation is available in the local app.*does not create messages or use personal contact information/i,
    );
    await userEvent.setup().click(button);
    expect(generateOutreachDraft).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Install JobCtrl" })).toHaveAttribute(
      "href",
      "https://jobctrl.dev/user/getting-started",
    );
  });
});
