import type { Meta, StoryObj } from "@storybook/react-vite";

import { ScoreBadge } from "./ScoreBadge.js";

const meta = {
  title: "Contexts/Scoring/ScoreBadge",
  component: ScoreBadge,
} satisfies Meta<typeof ScoreBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Score1: Story = { args: { score: 1 } };
export const Score2: Story = { args: { score: 2 } };
export const Score3: Story = { args: { score: 3 } };
export const Score4: Story = { args: { score: 4 } };
export const Score5: Story = { args: { score: 5 } };
export const Score6: Story = { args: { score: 6 } };
export const Score7: Story = { args: { score: 7 } };
export const Score8: Story = { args: { score: 8 } };
export const Score9: Story = { args: { score: 9 } };
export const Score10: Story = { args: { score: 10 } };
export const Unscored: Story = { args: { score: null } };
