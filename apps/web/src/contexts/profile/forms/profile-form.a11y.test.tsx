import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { sampleProfileResponse } from "../../../test/fixtures/projections.js";
import { ProfileForm } from "./profile-form.js";

describe("<ProfileForm> a11y", () => {
  it("has no critical axe violations on initial render", async () => {
    const view = renderWithProviders(<ProfileForm initial={sampleProfileResponse} />, {
      withRouter: true,
    });
    const results = await axe(view.container);
    expect(results).toHaveNoViolations();
  });
});
