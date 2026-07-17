import { axe } from "jest-axe";
import { render } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  degradedEmployerAnalysis,
  populatedEmployerAnalysis,
  populatedRequirementFitReport,
} from "../../../test/fixtures/materials-inspector.js";
import { EmployerAnalysisPanel } from "./EmployerAnalysisPanel.js";

describe("<EmployerAnalysisPanel> a11y", () => {
  it("has no critical/serious axe violations when populated", async () => {
    const user = userEvent.setup();
    const view = render(
      <EmployerAnalysisPanel
        analysis={populatedEmployerAnalysis}
        requirementFitReport={populatedRequirementFitReport}
        resolveEvidenceReference={(evidenceId) => ({
          entryId: evidenceId,
          title: "Led a platform reliability transformation",
          excerpt: "Reduced incident response time by 42%.",
        })}
      />,
    );
    for (const disclosure of view.getAllByRole("button", {
      name: "Technical details",
    })) {
      await user.click(disclosure);
    }
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it("has no critical/serious axe violations when degraded", async () => {
    const view = render(
      <EmployerAnalysisPanel analysis={degradedEmployerAnalysis} />,
    );
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it("has no critical/serious axe violations in the not-recorded state", async () => {
    const view = render(<EmployerAnalysisPanel analysis={null} />);
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
