import type { Meta, StoryObj } from "@storybook/react-vite";

import { makeJobDetail, sampleJob, sampleSecondaryJob } from "../../test/fixtures/projections.js";
import { JobOverview } from "./JobOverview.js";

const meta = {
  title: "Views/Jobs/JobOverview",
  component: JobOverview,
  args: {
    detail: makeJobDetail(sampleJob),
  },
} satisfies Meta<typeof JobOverview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const HighFitJob: Story = {
  args: { detail: makeJobDetail(sampleSecondaryJob) },
};

export const Unscored: Story = {
  args: {
    detail: makeJobDetail({
      ...sampleJob,
      fitScore: null,
      location: "",
      salary: "",
      source: "",
    }),
  },
};
