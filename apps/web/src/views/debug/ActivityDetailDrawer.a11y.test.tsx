import { axe } from "jest-axe";
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../test/render.js";
import { ActivityDetailDrawer } from "./ActivityDetailDrawer.js";

describe("<ActivityDetailDrawer> a11y", () => {
  it("has no critical axe violations when populated from MSW", async () => {
    const view = renderWithProviders(<ActivityDetailDrawer eventId="evt-1" />, {
      withRouter: true,
    });
    await waitFor(() => expect(view.container.querySelector("h1")).not.toBeNull());
    const results = await axe(view.container);
    expect(results).toHaveNoViolations();
  });
});
