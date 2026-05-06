import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { sampleSettingsResponse } from "../../../test/fixtures/projections.js";
import { SettingsForm } from "./settings-form.js";

describe("<SettingsForm> a11y", () => {
  it("has no critical axe violations on initial render", async () => {
    const view = renderWithProviders(<SettingsForm initial={sampleSettingsResponse.settings} />);
    const results = await axe(view.container);
    expect(results).toHaveNoViolations();
  });
});
