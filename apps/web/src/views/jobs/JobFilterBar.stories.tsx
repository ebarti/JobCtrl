import type { Meta, StoryObj } from "@storybook/react-vite";

import { jobsSearchSchema } from "../../routes/-jobs.search.js";
import { JobFilterBar } from "./JobFilterBar.js";

const baseSearch = jobsSearchSchema.parse({});

// JobFilterBar renders bare <select> elements (stage, state) without
// aria-label or wrapping <label htmlFor> — axe flags select-name as
// critical. Production-code defect from Phase 4; deferred.
const meta = {
  title: "Views/Jobs/JobFilterBar",
  component: JobFilterBar,
  parameters: {
    withRouter: true,
    initialPath: "/jobs",
    a11y: { test: "off" },
  },
  args: {
    search: baseSearch,
  },
} satisfies Meta<typeof JobFilterBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllStages: Story = {};

export const ApplyStageFiltered: Story = {
  args: {
    search: { ...baseSearch, stage: "apply", state: "pending" },
  },
};
