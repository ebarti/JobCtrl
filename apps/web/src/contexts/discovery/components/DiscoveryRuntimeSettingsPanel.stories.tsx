import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";

import { sampleDiscoverySettingsResponse } from "../../../test/fixtures/projections.js";
import { DiscoveryRuntimeSettingsPanel } from "./DiscoveryRuntimeSettingsPanel.js";

const meta = {
  title: "Contexts/Discovery/DiscoveryRuntimeSettingsPanel",
  component: DiscoveryRuntimeSettingsPanel,
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
          settings: { ...sampleDiscoverySettingsResponse.settings, triageBatchSize: 20 },
          effectiveSettings: {
            ...sampleDiscoverySettingsResponse.effectiveSettings,
            triageBatchSize: {
              value: 20,
              source: "environment",
              activation: "next_source_family",
              editable: false,
            },
          },
        })),
      ],
    },
  },
};
