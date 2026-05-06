import type { Meta, StoryObj } from "@storybook/react-vite";

import { ScoreReasoning } from "./ScoreReasoning.js";

const meta = {
  title: "Contexts/Scoring/ScoreReasoning",
  component: ScoreReasoning,
} satisfies Meta<typeof ScoreReasoning>;

export default meta;
type Story = StoryObj<typeof meta>;

export const KeywordsOnly: Story = {
  args: {
    fitScore: 7,
    text: "kubernetes, observability, on-call leadership",
  },
};

export const ReasonWithKeywords: Story = {
  args: {
    fitScore: 9,
    text: "Strong fit. keywords: kubernetes, sre, platform leadership",
  },
};

export const NoReason: Story = {
  args: {
    fitScore: 4,
    text: "",
  },
};
