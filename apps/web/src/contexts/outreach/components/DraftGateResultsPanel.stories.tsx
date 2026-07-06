import type { Meta, StoryObj } from "@storybook/react-vite";

import { makeGateResultsBlocked, makeGateResultsPassing } from "../../../test/fixtures/outreach.js";
import { DraftGateResultsPanel } from "./DraftGateResultsPanel.js";

const meta = {
  title: "Contexts/Outreach/DraftGateResultsPanel",
  component: DraftGateResultsPanel,
  args: { gateResults: makeGateResultsPassing() },
} satisfies Meta<typeof DraftGateResultsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Passed: Story = {};

export const BlockedWithFabrication: Story = {
  args: { gateResults: makeGateResultsBlocked() },
};
