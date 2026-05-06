import { axe } from "jest-axe";
import { describe, expect, it, beforeEach } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { ImportPreviewForm } from "./import-preview-form.js";
import { useProfileImportStore } from "../stores/profile-import-store.js";

beforeEach(() => {
  useProfileImportStore.setState({
    filename: "resume.pdf",
    pdfBase64: "JVBERi0=",
    importProfile: true,
    importStyle: true,
  });
});

describe("<ImportPreviewForm> a11y", () => {
  it("has no critical axe violations on initial render", async () => {
    const view = renderWithProviders(<ImportPreviewForm />, { withRouter: true });
    const results = await axe(view.container);
    expect(results).toHaveNoViolations();
  });
});
