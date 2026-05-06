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

export const Populated: Story = {};

export const AllUnconfigured: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/credentials", () =>
          HttpResponse.json({
            ok: true,
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
