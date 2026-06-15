import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  degradedEmployerAnalysis,
  emptyEmployerAnalysis,
  populatedEmployerAnalysis,
} from "../../../test/fixtures/materials-inspector.js";
import { EmployerAnalysisPanel } from "./EmployerAnalysisPanel.js";

const meta = {
  title: "Contexts/Materials/EmployerAnalysisPanel",
  component: EmployerAnalysisPanel,
} satisfies Meta<typeof EmployerAnalysisPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  args: {
    analysis: populatedEmployerAnalysis,
    scoreEvidence: {
      matchedSignals: ["platform reliability"],
      missingSignals: ["Kubernetes-based developer platforms"],
      transferableSignals: ["incident leadership"],
    },
  },
};

export const Degraded: Story = {
  args: { analysis: degradedEmployerAnalysis },
};

export const EmptyRequirementsAndKeywords: Story = {
  args: { analysis: emptyEmployerAnalysis },
};

export const NotRecorded: Story = {
  args: { analysis: null },
};
