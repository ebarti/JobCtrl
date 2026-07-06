import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import { sampleContactAttributes } from "../../../test/fixtures/contacts.js";
import { renderWithProviders } from "../../../test/render.js";
import { ContactProvenanceList } from "./ContactProvenanceList.js";

describe("<ContactProvenanceList> a11y", () => {
  it("renders every fact with provenance and has no critical axe violations", async () => {
    const view = renderWithProviders(
      <ContactProvenanceList attributes={sampleContactAttributes} />,
    );
    expect(view.getByText("dana.reyes@acme.example")).toBeInTheDocument();
    const results = await axe(view.container);
    expect(results).toHaveNoViolations();
  });
});
