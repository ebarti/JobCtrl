import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import { sampleDiscoverySettingsResponse } from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { DiscoveryRuntimeSettingsForm } from "./DiscoveryRuntimeSettingsPanel.js";

describe("<DiscoveryRuntimeSettingsForm> a11y", () => {
  it("has no axe violations", async () => {
    const view = renderWithProviders(
      <DiscoveryRuntimeSettingsForm initial={sampleDiscoverySettingsResponse} />,
    );
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
