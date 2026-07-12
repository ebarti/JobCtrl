import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";

import {
  sampleHealthResponse,
  sampleSettingsResponse,
} from "../../../test/fixtures/projections.js";
import { SettingsPanel } from "./SettingsPanel.js";

const meta = {
  title: "Contexts/Profile/SettingsPanel",
  component: SettingsPanel,
} satisfies Meta<typeof SettingsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

export const EnvironmentManagedRestartPending: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/settings", () =>
          HttpResponse.json({
            ...sampleSettingsResponse,
            settings: { ...sampleSettingsResponse.settings, workerActivitySlots: 8 },
            effectiveSettings: {
              ...sampleSettingsResponse.effectiveSettings,
              workerActivitySlots: {
                value: 8,
                source: "environment",
                activation: "restart",
                editable: false,
              },
            },
          }),
        ),
        http.get("*/v1/health", () => HttpResponse.json(sampleHealthResponse)),
      ],
    },
  },
};

export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/settings", async () => {
          await new Promise((resolve) => setTimeout(resolve, 60_000));
          return HttpResponse.json(sampleSettingsResponse);
        }),
      ],
    },
  },
};

export const Error: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/settings", () =>
          HttpResponse.json({ ok: false, error: "internal" }, { status: 500 }),
        ),
      ],
    },
  },
};
