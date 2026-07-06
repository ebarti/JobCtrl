import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  sampleAcceptedResumeArtifact,
  sampleDraftResumeArtifact,
} from "../../../test/fixtures/projections.js";
import { ArtifactComparison } from "./ArtifactComparison.js";

const meta = {
  title: "Contexts/Materials/ArtifactComparison",
  component: ArtifactComparison,
} satisfies Meta<typeof ArtifactComparison>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RecordedCoverage: Story = {
  args: {
    leftArtifactId: sampleAcceptedResumeArtifact.artifactId,
    leftLabel: "Accepted",
    rightArtifactId: sampleDraftResumeArtifact.artifactId,
    rightLabel: "Rendered draft",
    rightRiskLabels: ["claim risk"],
  },
};

export const CoverageNotRecorded: Story = {
  args: {
    leftArtifactId: sampleAcceptedResumeArtifact.artifactId,
    leftLabel: "Accepted",
    rightArtifactId: "artifact-no-coverage",
    rightLabel: "Legacy artifact",
  },
};

export const EmptySelection: Story = {
  args: {
    leftArtifactId: sampleAcceptedResumeArtifact.artifactId,
    rightArtifactId: null,
  },
};
