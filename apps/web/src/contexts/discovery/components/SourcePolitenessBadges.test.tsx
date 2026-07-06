import type { SourcePolitenessOutcomes } from "@jobhunter/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  SourcePolitenessBadges,
  hasPolitenessOutcomes,
  politenessOutcomeSummary,
} from "./SourcePolitenessBadges.js";

function outcomes(overrides: Partial<SourcePolitenessOutcomes> = {}): SourcePolitenessOutcomes {
  return {
    robotsDisallowedCount: 0,
    rateLimitedCount: 0,
    budgetExhaustedCount: 0,
    lastBlockedReason: null,
    lastBlockedAt: null,
    ...overrides,
  };
}

describe("SourcePolitenessBadges", () => {
  it("renders a neutral, factual badge for a robots-disallowed outcome", () => {
    render(
      <SourcePolitenessBadges
        politeness={outcomes({ robotsDisallowedCount: 2, lastBlockedReason: "robots_disallowed" })}
        sourceLabel="Acme"
      />,
    );
    const badge = screen.getByText("robots disallowed");
    expect(badge).toBeInTheDocument();
    expect(badge.closest(".source-politeness-badge")).toHaveTextContent("2");
    expect(badge.closest(".source-politeness-badge")).toHaveAttribute(
      "title",
      "robots disallowed: 2 times for Acme",
    );
  });

  it("renders a rate-limited badge", () => {
    render(<SourcePolitenessBadges politeness={outcomes({ rateLimitedCount: 1 })} />);
    const badge = screen.getByText("rate limited");
    expect(badge).toBeInTheDocument();
    expect(badge.closest(".source-politeness-badge")).toHaveAttribute(
      "title",
      "rate limited: 1 time",
    );
  });

  it("renders a budget-exhausted badge", () => {
    render(<SourcePolitenessBadges politeness={outcomes({ budgetExhaustedCount: 4 })} />);
    expect(screen.getByText("budget exhausted")).toBeInTheDocument();
  });

  it("renders every recorded outcome together", () => {
    render(
      <SourcePolitenessBadges
        politeness={outcomes({
          robotsDisallowedCount: 1,
          rateLimitedCount: 2,
          budgetExhaustedCount: 3,
        })}
      />,
    );
    expect(screen.getByText("robots disallowed")).toBeInTheDocument();
    expect(screen.getByText("rate limited")).toBeInTheDocument();
    expect(screen.getByText("budget exhausted")).toBeInTheDocument();
  });

  it("renders nothing when no politeness outcome was recorded (honest empty state)", () => {
    const { container } = render(<SourcePolitenessBadges politeness={outcomes()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("reports whether outcomes exist and summarises the recorded reasons", () => {
    expect(hasPolitenessOutcomes(outcomes())).toBe(false);
    expect(hasPolitenessOutcomes(outcomes({ rateLimitedCount: 1 }))).toBe(true);
    expect(politenessOutcomeSummary(outcomes())).toBe("");
    expect(
      politenessOutcomeSummary(outcomes({ robotsDisallowedCount: 1, budgetExhaustedCount: 2 })),
    ).toBe("robots disallowed budget exhausted");
  });
});
