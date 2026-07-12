import type { Meta, StoryObj } from "@storybook/react-vite";

import { ScoringGuidancePanel } from "./ScoringGuidancePanel.js";

const meta = { title: "Contexts/Scoring/ScoringGuidancePanel", component: ScoringGuidancePanel } satisfies Meta<typeof ScoringGuidancePanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
