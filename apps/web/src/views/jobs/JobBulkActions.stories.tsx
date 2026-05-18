import type { Meta, StoryObj } from "@storybook/react-vite";

import { jobsSearchSchema } from "../../routes/-jobs.search.js";
import { JobBulkActions } from "./JobBulkActions.js";

const baseSearch = jobsSearchSchema.parse({});

const meta = {
  title: "Views/Jobs/JobBulkActions",
  component: JobBulkActions,
  args: {
    search: baseSearch,
    selectedCount: 0,
    hasItems: true,
    hasAnyMatching: true,
    loading: false,
    onSetDeleted: () => {},
    onSelectPage: () => {},
    onSelectAllMatching: () => {},
    onClearSelection: () => {},
    onPrimaryAction: () => {},
    onHideSelected: () => {},
  },
} satisfies Meta<typeof JobBulkActions>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = {};

export const SomeSelected: Story = {
  args: { selectedCount: 3 },
};

export const RestoringDeleted: Story = {
  args: {
    search: { ...baseSearch, deleted: "deleted" },
    selectedCount: 5,
  },
};

export const HiddenJobs: Story = {
  args: {
    search: { ...baseSearch, deleted: "hidden" },
    selectedCount: 2,
  },
};

export const AllSelectionDisabled: Story = {
  args: {
    hasItems: false,
    hasAnyMatching: false,
  },
};
