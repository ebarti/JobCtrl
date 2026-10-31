import { axe } from "jest-axe";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { ApplyRuntimeSettingsPanel } from "./ApplyRuntimeSettingsPanel.js";

describe("Apply runtime settings a11y", () => {
  it("has no axe violations", async () => {
    const view = renderWithProviders(<ApplyRuntimeSettingsPanel />);
    await screen.findByLabelText("Apply agent timeout (seconds)");
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
