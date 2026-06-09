import { axe } from "jest-axe";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { annotatedChanges, provenanceEntries } from "../../../test/fixtures/materials-inspector.js";
import { BulletProvenanceList } from "./BulletProvenanceList.js";

describe("<BulletProvenanceList> a11y", () => {
  it("has no critical/serious axe violations when populated with the diff", async () => {
    const view = render(
      <BulletProvenanceList provenance={provenanceEntries} annotatedChanges={annotatedChanges} />,
    );
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it("has no critical/serious axe violations in the empty state", async () => {
    const view = render(<BulletProvenanceList provenance={[]} />);
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
