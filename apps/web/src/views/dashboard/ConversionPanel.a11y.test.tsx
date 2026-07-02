import { render } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import type { DashboardSummary } from "../../contexts/operations/types.js";
import { sampleDashboardSummary } from "../../test/fixtures/projections.js";
import { ConversionPanel } from "./ConversionPanel.js";

const emptySummary: DashboardSummary = {
  ...sampleDashboardSummary,
  conversion: {
    totals: {
      applied: 0,
      reply: 0,
      interview: 0,
      offer: 0,
      rejection: 0,
      replyRate: null,
      interviewRate: null,
      offerRate: null,
      rejectionRate: null,
      costPerInterview: null,
    },
    bySource: [],
    byBand: [],
  },
};

describe("<ConversionPanel> a11y", () => {
  it("has no axe violations when populated", async () => {
    const { container } = render(
      <main>
        <ConversionPanel summary={sampleDashboardSummary} />
      </main>,
    );

    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no axe violations in the empty state", async () => {
    const { container } = render(
      <main>
        <ConversionPanel summary={emptySummary} />
      </main>,
    );

    expect(await axe(container)).toHaveNoViolations();
  });
});
