import type { Meta, StoryObj } from "@storybook/react-vite";

import { ScoreBreakdown } from "./ScoreBreakdown.js";

const meta = {
  title: "Contexts/Scoring/ScoreBreakdown",
  component: ScoreBreakdown,
} satisfies Meta<typeof ScoreBreakdown>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  args: {
    fitScore: 8,
    scoreBreakdown: {
      technicalFit: 9,
      experienceFit: 7,
      roleFit: 8,
      reasoning: "Strong fit on platform reliability and SRE leadership.",
      fitBand: "strong",
      confidence: "high",
      eligibility: { status: "eligible", hardBlockers: [], warnings: [] },
      matchedSignals: ["platform reliability", "SRE leadership"],
      missingSignals: ["public company scale"],
      transferableSignals: ["incident leadership"],
    },
    scoreKeywords: ["kubernetes", "observability", "on-call leadership"],
    scoreReasoning:
      "Strong fit on platform reliability and SRE leadership. keywords: kubernetes, observability, on-call leadership",
    scoreVersion: 2,
    scoredAt: "2026-05-05T09:30:00+00:00",
    scoreCriteria: {
      minFitScore: 7,
      criteriaText: "Platform reliability.",
      targetCriteria: "Remote infrastructure leadership.",
      criteriaVersion: "criteria-1",
    },
    scoreTrace: {
      promptVersion: "score-fit-assessment-v1",
      schemaVersion: "score-fit-assessment-v1",
      model: "fake",
      criteriaVersion: "criteria-1",
      profileSnapshotVersion: 2,
      parserWarnings: [],
      correctionHistory: [],
    },
    scoreCorrection: null,
  },
};

export const LegacyReasoning: Story = {
  args: {
    fitScore: 6,
    scoreBreakdown: null,
    scoreKeywords: [],
    scoreReasoning:
      "Strong fit on platform reliability and SRE leadership. keywords: kubernetes, observability, on-call leadership",
    scoreVersion: 1,
    scoredAt: "2026-05-01T10:00:00+00:00",
  },
};

export const Unscored: Story = {
  args: {
    fitScore: null,
    scoreBreakdown: null,
    scoreKeywords: [],
    scoreReasoning: "",
    scoreVersion: null,
    scoredAt: null,
  },
};
