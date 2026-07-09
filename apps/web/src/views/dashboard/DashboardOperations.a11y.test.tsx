import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import {
  sampleDashboardSummary,
  sampleWorkflowRun,
} from "../../test/fixtures/projections.js";
import { renderWithProviders } from "../../test/render.js";
import { ActiveRunsCard } from "./ActiveRunsCard.js";
import { RecentActivityCard } from "./RecentActivityCard.js";
import { WorkStatusCard } from "./WorkStatusCard.js";

describe("dashboard operations surfaces a11y", () => {
  it("has no axe violations with active, stuck, and recent work", async () => {
    const view = renderWithProviders(
      <main>
        <WorkStatusCard summary={sampleDashboardSummary} />
        <ActiveRunsCard
          runs={[sampleWorkflowRun]}
          loading={false}
          error={null}
        />
        <RecentActivityCard summary={sampleDashboardSummary} />
      </main>,
      { withRouter: true },
    );

    expect(await axe(view.container)).toHaveNoViolations();
  });
});
