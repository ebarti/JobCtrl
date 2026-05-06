import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { ImportUploadForm } from "./import-upload-form.js";

describe("<ImportUploadForm> a11y", () => {
  it("has no critical axe violations on initial render", async () => {
    const view = renderWithProviders(<ImportUploadForm />, { withRouter: true });
    const results = await axe(view.container);
    expect(results).toHaveNoViolations();
  });
});
