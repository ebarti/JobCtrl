import { axe } from "jest-axe";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  degradedEmployerAnalysis,
  populatedEmployerAnalysis,
} from "../../../test/fixtures/materials-inspector.js";
import { EmployerAnalysisPanel } from "./EmployerAnalysisPanel.js";

describe("<EmployerAnalysisPanel> a11y", () => {
  it("has no critical/serious axe violations when populated", async () => {
    const view = render(
      <EmployerAnalysisPanel
        analysis={populatedEmployerAnalysis}
        scoreEvidence={{
          matchedSignals: ["platform reliability"],
          missingSignals: ["Kubernetes-based developer platforms"],
          transferableSignals: ["incident leadership"],
        }}
      />,
    );
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it("has no critical/serious axe violations when degraded", async () => {
    const view = render(<EmployerAnalysisPanel analysis={degradedEmployerAnalysis} />);
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it("has no critical/serious axe violations in the not-recorded state", async () => {
    const view = render(<EmployerAnalysisPanel analysis={null} />);
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
