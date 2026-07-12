import type { Meta, StoryObj } from "@storybook/react-vite";

import { BrowserCapabilitiesPanel } from "./BrowserCapabilitiesPanel.js";

const meta = { title: "Contexts/Operations/BrowserCapabilitiesPanel", component: BrowserCapabilitiesPanel } satisfies Meta<typeof BrowserCapabilitiesPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
