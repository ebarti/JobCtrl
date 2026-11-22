import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";

import { sampleDiscoverySettingsResponse } from "../../../../.storybook/fixtures/projections.js";
import { DiscoveryRuntimeSettingsPanel } from "./DiscoveryRuntimeSettingsPanel.js";

const meta = {
  title: "Contexts/Discovery/DiscoveryRuntimeSettingsPanel",
  component: DiscoveryRuntimeSettingsPanel,
  tags: ["search-settings"],
} satisfies Meta<typeof DiscoveryRuntimeSettingsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const EnvironmentManaged: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/discovery/settings", () => HttpResponse.json({
          ...sampleDiscoverySettingsResponse,
          settings: { ...sampleDiscoverySettingsResponse.settings, hoursOld: 72 },
          effectiveSettings: {
            ...sampleDiscoverySettingsResponse.effectiveSettings,
            hoursOld: {
              value: 72,
              source: "environment",
              activation: "next_run",
              editable: false,
            },
          },
        })),
      ],
    },
  },
};
