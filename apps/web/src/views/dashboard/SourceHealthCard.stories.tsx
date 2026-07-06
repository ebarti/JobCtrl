import type { Meta, StoryObj } from "@storybook/react-vite";
import type { DashboardSummary } from "../../contexts/operations/types.js";

import { sampleDashboardSummary } from "../../test/fixtures/projections.js";
import { SourceHealthCard } from "./SourceHealthCard.js";

type SourceHealth = DashboardSummary["sourceHealth"][number];

const [baseSource] = sampleDashboardSummary.sourceHealth;

function source(sourceId: string, politeness: SourceHealth["politeness"]): SourceHealth {
  return { ...baseSource!, sourceId, politeness };
}

const meta = {
  title: "Views/Dashboard/SourceHealthCard",
  component: SourceHealthCard,
  args: {
    summary: sampleDashboardSummary,
  },
} satisfies Meta<typeof SourceHealthCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

export const MixedPoliteness: Story = {
  args: {
    summary: {
      ...sampleDashboardSummary,
      sourceHealth: [
        source("greenhouse:acme", {
          robotsDisallowedCount: 3,
          rateLimitedCount: 0,
          budgetExhaustedCount: 0,
          lastBlockedReason: "robots_disallowed",
          lastBlockedAt: "2026-05-06T07:40:00Z",
        }),
        source("lever:globex", {
          robotsDisallowedCount: 0,
          rateLimitedCount: 4,
          budgetExhaustedCount: 2,
          lastBlockedReason: "budget_exhausted",
          lastBlockedAt: "2026-05-06T07:50:00Z",
        }),
        source("workday:initech", {
          robotsDisallowedCount: 0,
          rateLimitedCount: 0,
          budgetExhaustedCount: 0,
          lastBlockedReason: null,
          lastBlockedAt: null,
        }),
      ],
    },
  },
};

export const Empty: Story = {
  args: {
    summary: { ...sampleDashboardSummary, sourceHealth: [] },
  },
};
