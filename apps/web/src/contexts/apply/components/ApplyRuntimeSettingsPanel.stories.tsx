import type { Meta, StoryObj } from "@storybook/react-vite";

import { ApplyRuntimeSettingsPanel } from "./ApplyRuntimeSettingsPanel.js";

const meta = { title: "Contexts/Apply/ApplyRuntimeSettingsPanel", component: ApplyRuntimeSettingsPanel } satisfies Meta<typeof ApplyRuntimeSettingsPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
