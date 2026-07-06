import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { useOutreachImportStore } from "../stores/outreach-import-store.js";
import { ContactImportWizard } from "./contact-import-wizard.js";

describe("<ContactImportWizard> a11y", () => {
  it("has no critical axe violations on the upload step", async () => {
    useOutreachImportStore.getState().reset();
    const view = renderWithProviders(<ContactImportWizard />);
    const results = await axe(view.container);
    expect(results).toHaveNoViolations();
  });
});
