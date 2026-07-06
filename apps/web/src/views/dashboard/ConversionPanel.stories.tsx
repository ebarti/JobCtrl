import type { Meta, StoryObj } from "@storybook/react-vite";

import type { DashboardSummary } from "../../contexts/operations/types.js";
import { sampleDashboardSummary } from "../../test/fixtures/projections.js";
import { ConversionPanel } from "./ConversionPanel.js";

type ConversionFunnel = DashboardSummary["conversion"]["totals"];

function funnel(
  applied: number,
  reply: number,
  interview: number,
  offer: number,
  rejection: number,
  costPerInterview: number | null = null,
): ConversionFunnel {
  const rate = (value: number) => (applied > 0 ? Math.round((value / applied) * 10000) / 10000 : null);
  return {
    applied,
    reply,
    interview,
    offer,
    rejection,
    replyRate: rate(reply),
    interviewRate: rate(interview),
    offerRate: rate(offer),
    rejectionRate: rate(rejection),
    costPerInterview,
  };
}

const meta = {
  title: "Views/Dashboard/ConversionPanel",
  component: ConversionPanel,
  parameters: {
    initialPath: "/dashboard",
  },
  args: {
    summary: sampleDashboardSummary,
  },
} satisfies Meta<typeof ConversionPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

export const MultipleSourcesAndBands: Story = {
  args: {
    summary: {
      ...sampleDashboardSummary,
      conversion: {
        totals: funnel(20, 11, 6, 2, 4),
        bySource: [
          { source: "greenhouse:acme", ...funnel(9, 6, 4, 2, 1) },
          { source: "jobspy:linkedin", ...funnel(7, 3, 1, 0, 2) },
          { source: "lever:globex", ...funnel(4, 2, 1, 0, 1) },
        ],
        byBand: [
          { band: "perfect", ...funnel(3, 3, 2, 1, 0) },
          { band: "strong", ...funnel(8, 5, 3, 1, 1) },
          { band: "moderate", ...funnel(6, 2, 1, 0, 2) },
          { band: "weak", ...funnel(3, 1, 0, 0, 1) },
        ],
      },
    },
  },
};

export const CostPerInterviewAvailable: Story = {
  args: {
    summary: {
      ...sampleDashboardSummary,
      conversion: {
        ...sampleDashboardSummary.conversion,
        totals: funnel(20, 11, 6, 2, 4, 128),
      },
    },
  },
};

export const SmallSample: Story = {
  args: {
    summary: {
      ...sampleDashboardSummary,
      conversion: {
        // Below MIN_CONVERSION_SAMPLE: the read model returns null rates, so the
        // panel shows raw counts, "n/a" instead of a fabricated percentage, and an
        // insufficient-data note.
        totals: {
          applied: 1,
          reply: 1,
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
    },
  },
};

export const Empty: Story = {
  args: {
    summary: {
      ...sampleDashboardSummary,
      conversion: {
        totals: funnel(0, 0, 0, 0, 0),
        bySource: [],
        byBand: [],
      },
    },
  },
};
