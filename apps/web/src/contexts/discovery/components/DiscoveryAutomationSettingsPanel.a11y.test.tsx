import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import { sampleDiscoverySettingsResponse } from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { DiscoveryAutomationSettingsForm } from "./DiscoveryAutomationSettingsPanel.js";

describe("<DiscoveryAutomationSettingsForm> a11y", () => {
  it("has no axe violations with shared labels, controls, and feedback", async () => {
    const view = renderWithProviders(
      <DiscoveryAutomationSettingsForm initial={sampleDiscoverySettingsResponse} />,
    );

    expect(await axe(view.container)).toHaveNoViolations();
  });
});
