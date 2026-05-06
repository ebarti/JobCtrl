import { axe } from "jest-axe";
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../test/render.js";
import { ApplyRunDrawer } from "./ApplyRunDrawer.js";

describe("<ApplyRunDrawer> a11y", () => {
  it("has no critical axe violations when populated from MSW", async () => {
    const view = renderWithProviders(<ApplyRunDrawer runId="run-1" />, { withRouter: true });
    await waitFor(() => expect(view.container.querySelector("h2")).not.toBeNull());
    const results = await axe(view.container);
    expect(results).toHaveNoViolations();
  });
});
