import type { Meta, StoryObj } from "@storybook/react-vite";
import { delay, http, HttpResponse } from "msw";

import {
  sampleCredentialsResponse,
  sampleProviderStatusResponse,
} from "../../../test/fixtures/projections.js";
import { CredentialsPanel } from "./CredentialsPanel.js";

const meta = {
  title: "Contexts/Profile/CredentialsPanel",
  component: CredentialsPanel,
} satisfies Meta<typeof CredentialsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Configured: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/providers/status", () =>
          HttpResponse.json(sampleProviderStatusResponse),
        ),
      ],
    },
  },
};

export const Unconfigured: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/credentials", () =>
          HttpResponse.json({
            ...sampleCredentialsResponse,
            credentials: sampleCredentialsResponse.credentials.map((entry) => ({
              ...entry,
              configured: false,
            })),
          }),
        ),
        http.get("*/v1/providers/status", () =>
          HttpResponse.json({
            ok: true,
            providers: sampleProviderStatusResponse.providers.map((provider) => ({
              ...provider,
              configured: false,
              ready: false,
              mode: null,
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
        http.get("*/v1/credentials", async () => {
          await delay("infinite");
          return HttpResponse.json(sampleCredentialsResponse);
        }),
        http.get("*/v1/providers/status", async () => {
          await delay("infinite");
          return HttpResponse.json(sampleProviderStatusResponse);
        }),
      ],
    },
  },
};

export const Error: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/credentials", () =>
          HttpResponse.json({ ok: false, error: "internal" }, { status: 500 }),
        ),
        http.get("*/v1/providers/status", () =>
          HttpResponse.json(
            { ok: false, error: "provider_status_failed" },
            { status: 503 },
          ),
        ),
      ],
    },
  },
};

export const InspectionFailed: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/credentials", () =>
          HttpResponse.json({
            ...sampleCredentialsResponse,
            store: {
              ...sampleCredentialsResponse.store,
              available: false,
              unavailableReason: "inspection_failed",
            },
            credentials: sampleCredentialsResponse.credentials.map((entry) => ({
              ...entry,
              configured: null,
            })),
          }),
        ),
      ],
    },
  },
};
