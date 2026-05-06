import type { Meta, StoryObj } from "@storybook/react-vite";

import { artifactsSearchSchema } from "../../routes/-artifacts.search.js";
import { ArtifactFilterBar } from "./ArtifactFilterBar.js";

const baseSearch = artifactsSearchSchema.parse({});

// Same bare <select> defect as JobFilterBar — production-code issue
// from Phase 4. Deferred.
const meta = {
  title: "Views/Artifacts/ArtifactFilterBar",
  component: ArtifactFilterBar,
  parameters: {
    withRouter: true,
    initialPath: "/artifacts",
    a11y: { test: "off" },
  },
  args: {
    search: baseSearch,
  },
} satisfies Meta<typeof ArtifactFilterBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllStatuses: Story = {};

export const ApprovedOnly: Story = {
  args: {
    search: { ...baseSearch, status: "approved" },
  },
};

export const StaleOnly: Story = {
  args: {
    search: { ...baseSearch, status: "stale" },
  },
};
