import { render } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import { sampleOutcomeAnalyticsSummary } from "../../test/fixtures/projections.js";
import { DimensionBreakdownPanel } from "./DimensionBreakdownPanel.js";
import { SmallSampleNotice } from "./SmallSampleNotice.js";

describe("<AnalyticsView> a11y", () => {
  it("has no axe violations for the populated analytics panel body", async () => {
    const { container } = render(
      <main>
        <SmallSampleNotice minSample={5} />
        <DimensionBreakdownPanel
          analytics={sampleOutcomeAnalyticsSummary}
          dimension="fit_band"
          loading={false}
        />
      </main>,
    );

    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no axe violations for the empty analytics panel body", async () => {
    const { container } = render(
      <main>
        <SmallSampleNotice minSample={5} />
        <DimensionBreakdownPanel analytics={null} dimension="source" loading={false} />
      </main>,
    );

    expect(await axe(container)).toHaveNoViolations();
  });
});
