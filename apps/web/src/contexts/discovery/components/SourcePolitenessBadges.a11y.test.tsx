import { axe } from "jest-axe";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SourcePolitenessBadges } from "./SourcePolitenessBadges.js";

describe("<SourcePolitenessBadges> a11y", () => {
  it("has no critical/serious axe violations when every outcome is present", async () => {
    const view = render(
      <SourcePolitenessBadges
        politeness={{
          robotsDisallowedCount: 3,
          rateLimitedCount: 2,
          budgetExhaustedCount: 1,
          lastBlockedReason: "budget_exhausted",
          lastBlockedAt: "2026-05-16T09:10:00Z",
        }}
        sourceLabel="Acme"
      />,
    );
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it("has no critical/serious axe violations in the empty state", async () => {
    const view = render(
      <SourcePolitenessBadges
        politeness={{
          robotsDisallowedCount: 0,
          rateLimitedCount: 0,
          budgetExhaustedCount: 0,
          lastBlockedReason: null,
          lastBlockedAt: null,
        }}
      />,
    );
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
