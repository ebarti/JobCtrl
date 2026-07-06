import type { Meta, StoryObj } from "@storybook/react-vite";
import type { SourcePolitenessOutcomes } from "@jobhunter/contracts";

import { SourcePolitenessBadges } from "./SourcePolitenessBadges.js";

function outcomes(overrides: Partial<SourcePolitenessOutcomes>): SourcePolitenessOutcomes {
  return {
    robotsDisallowedCount: 0,
    rateLimitedCount: 0,
    budgetExhaustedCount: 0,
    lastBlockedReason: null,
    lastBlockedAt: null,
    ...overrides,
  };
}

const meta = {
  title: "Contexts/Discovery/SourcePolitenessBadges",
  component: SourcePolitenessBadges,
  args: {
    sourceLabel: "Acme",
  },
} satisfies Meta<typeof SourcePolitenessBadges>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RobotsDisallowed: Story = {
  args: {
    politeness: outcomes({ robotsDisallowedCount: 2, lastBlockedReason: "robots_disallowed" }),
  },
};

export const RateLimited: Story = {
  args: {
    politeness: outcomes({ rateLimitedCount: 5, lastBlockedReason: "rate_limited" }),
  },
};

export const BudgetExhausted: Story = {
  args: {
    politeness: outcomes({ budgetExhaustedCount: 1, lastBlockedReason: "budget_exhausted" }),
  },
};

export const AllOutcomes: Story = {
  args: {
    politeness: outcomes({
      robotsDisallowedCount: 3,
      rateLimitedCount: 2,
      budgetExhaustedCount: 1,
      lastBlockedReason: "budget_exhausted",
    }),
  },
};

// Honest empty state: nothing is recorded, so nothing renders.
export const NoOutcomes: Story = {
  args: {
    politeness: outcomes({}),
  },
};
