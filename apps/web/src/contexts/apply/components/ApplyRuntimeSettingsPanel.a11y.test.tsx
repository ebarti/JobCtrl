import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { ApplyRuntimeSettingsPanel } from "./ApplyRuntimeSettingsPanel.js";

describe("Apply runtime settings a11y", () => {
  it("has no axe violations", async () => {
    const view = renderWithProviders(<ApplyRuntimeSettingsPanel />);
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
