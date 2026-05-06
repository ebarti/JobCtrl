import type { Meta, StoryObj } from "@storybook/react-vite";

import { ScoreBreakdown } from "./ScoreBreakdown.js";

const meta = {
  title: "Contexts/Scoring/ScoreBreakdown",
  component: ScoreBreakdown,
} satisfies Meta<typeof ScoreBreakdown>;

export default meta;
type Story = StoryObj<typeof meta>;

export const KeywordOnly: Story = {
  args: {
    fitScore: 6,
    scoreReasoning: "platform engineering, distributed systems, sre",
  },
};

export const ReasonAndKeywords: Story = {
  args: {
    fitScore: 8,
    scoreReasoning:
      "Strong fit on platform reliability and SRE leadership. keywords: kubernetes, observability, on-call leadership",
  },
};

export const Unscored: Story = {
  args: {
    fitScore: null,
    scoreReasoning: "",
  },
};
