import type { Meta, StoryObj } from "@storybook/react-vite";

import { annotatedChanges, provenanceEntries } from "../../../test/fixtures/materials-inspector.js";
import { BulletProvenanceList } from "./BulletProvenanceList.js";

const meta = {
  title: "Contexts/Materials/BulletProvenanceList",
  component: BulletProvenanceList,
} satisfies Meta<typeof BulletProvenanceList>;

export default meta;
type Story = StoryObj<typeof meta>;

// Populated with the original → tailored diff sourced from annotated changes.
export const PopulatedWithDiff: Story = {
  args: { provenance: provenanceEntries, annotatedChanges },
};

// Missing original bullet (drafted-adjacent) — explicit "not recorded" diff side.
export const MissingOriginalBullet: Story = {
  args: { provenance: [provenanceEntries[1]!], annotatedChanges: [] },
};

// Covered keywords present (the rephrased bullet demonstrates a keyword).
export const CoveredKeywords: Story = {
  args: { provenance: [provenanceEntries[0]!], annotatedChanges },
};

export const Empty: Story = {
  args: { provenance: [] },
};
