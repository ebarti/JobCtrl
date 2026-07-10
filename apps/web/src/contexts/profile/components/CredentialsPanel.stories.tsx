import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";

import { sampleCredentialsResponse } from "../../../test/fixtures/projections.js";
import { CredentialsPanel } from "./CredentialsPanel.js";

const meta = {
  title: "Contexts/Profile/CredentialsPanel",
  component: CredentialsPanel,
} satisfies Meta<typeof CredentialsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Present: Story = {};

export const Absent: Story = {
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

export const UnsupportedPlatform: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/credentials", () =>
          HttpResponse.json({
            ...sampleCredentialsResponse,
            store: {
              ...sampleCredentialsResponse.store,
              available: false,
              unavailableReason: "unsupported_platform",
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

export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/credentials", async () => {
          await new Promise((resolve) => setTimeout(resolve, 60_000));
          return HttpResponse.json(sampleCredentialsResponse);
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
      ],
    },
  },
};
