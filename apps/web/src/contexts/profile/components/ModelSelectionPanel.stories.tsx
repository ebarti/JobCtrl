import type { Meta, StoryObj } from "@storybook/react-vite";
import { delay, http, HttpResponse } from "msw";
import { useMemo } from "react";

import { PortsProvider, usePorts } from "../../../shared/providers/PortsProvider.js";
import {
  sampleProviderModelsResponse,
  sampleSettingsResponse,
} from "../../../test/fixtures/projections.js";
import { ModelSelectionPanel } from "./ModelSelectionPanel.js";

const meta = {
  title: "Contexts/Profile/ModelSelectionPanel",
  component: ModelSelectionPanel,
  parameters: { withRouter: true, initialPath: "/settings/models" },
} satisfies Meta<typeof ModelSelectionPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

export const Unready: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/providers/models", () =>
          HttpResponse.json({
            ...sampleProviderModelsResponse,
            providers: sampleProviderModelsResponse.providers.map((provider) => ({
              ...provider,
              configured: false,
              ready: false,
              models: [],
              message: `${provider.provider} is not configured.`,
            })),
          }),
        ),
      ],
    },
  },
};

export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/settings", async () => {
          await delay("infinite");
          return HttpResponse.json(sampleSettingsResponse);
        }),
        http.get("*/v1/providers/models", async () => {
          await delay("infinite");
          return HttpResponse.json(sampleProviderModelsResponse);
        }),
      ],
    },
  },
};

export const Error: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/providers/models", () =>
          HttpResponse.json(
            { ok: false, error: "provider_models_failed", message: "catalog unavailable" },
            { status: 503 },
          ),
        ),
      ],
    },
  },
};

export const DemoReadOnly: Story = {
  render: () => <DemoModeStory />,
};

function DemoModeStory() {
  const ports = usePorts();
  const demoPorts = useMemo(
    () => ({
      ...ports,
      featureFlags: {
        get<T extends boolean | number | string>(key: string, defaultValue: T): T {
          return (key === "demoMode" ? true : defaultValue) as T;
        },
      },
    }),
    [ports],
  );
  return (
    <PortsProvider ports={demoPorts}>
      <ModelSelectionPanel />
    </PortsProvider>
  );
}
