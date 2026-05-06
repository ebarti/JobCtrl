import { axe } from "jest-axe";
import { beforeEach, describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { ImportConfirmForm } from "./import-confirm-form.js";
import { useProfileImportStore } from "../stores/profile-import-store.js";

beforeEach(() => {
  useProfileImportStore.setState({
    filename: "resume.pdf",
    pdfBase64: "JVBERi0=",
    importProfile: true,
    importStyle: true,
  });
});

describe("<ImportConfirmForm> a11y", () => {
  it("has no critical axe violations on initial render", async () => {
    const view = renderWithProviders(<ImportConfirmForm />, { withRouter: true });
    const results = await axe(view.container);
    expect(results).toHaveNoViolations();
  });
});
