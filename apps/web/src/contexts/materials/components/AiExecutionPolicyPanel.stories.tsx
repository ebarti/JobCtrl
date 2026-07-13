import type { Meta, StoryObj } from "@storybook/react-vite";

import { AiExecutionPolicyPanel } from "./AiExecutionPolicyPanel.js";

const meta = { title: "Contexts/Materials/AiExecutionPolicyPanel", component: AiExecutionPolicyPanel } satisfies Meta<typeof AiExecutionPolicyPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
