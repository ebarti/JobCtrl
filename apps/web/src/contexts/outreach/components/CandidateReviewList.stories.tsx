import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  makeResearchTaskDetail,
  sampleResearchTaskDetail,
} from "../../../test/fixtures/contact-research.js";
import { CandidateReviewList } from "./CandidateReviewList.js";

const meta = {
  title: "Contexts/Outreach/CandidateReviewList",
  component: CandidateReviewList,
  args: { task: sampleResearchTaskDetail },
} satisfies Meta<typeof CandidateReviewList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NeedsReview: Story = {};

export const NoCandidates: Story = {
  args: {
    task: makeResearchTaskDetail({
      status: "needs_review",
      candidateCount: 0,
      needsReviewCount: 0,
      candidates: [],
    }),
  },
};

export const Confirmed: Story = {
  args: {
    task: makeResearchTaskDetail({
      status: "completed",
      needsReviewCount: 0,
      confirmedCount: 1,
      candidates: [
        {
          ...sampleResearchTaskDetail.candidates[0]!,
          status: "confirmed",
          confirmedContactId: "contact-1",
          confirmedAt: "2026-07-06T00:01:00+00:00",
        },
      ],
    }),
  },
};
