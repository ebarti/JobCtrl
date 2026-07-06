import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";

import { OutreachDetailDrawer } from "./OutreachDetailDrawer.js";

const meta = {
  title: "Views/Outreach/OutreachDetailDrawer",
  component: OutreachDetailDrawer,
  args: { contactId: "contact-1", onClose: () => undefined },
} satisfies Meta<typeof OutreachDetailDrawer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/contacts/:contactId", async () => {
          await new Promise((resolve) => setTimeout(resolve, 60_000));
          return HttpResponse.json({ ok: true });
        }),
      ],
    },
  },
};

export const NotFound: Story = {
  args: { contactId: "missing-contact" },
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/contacts/:contactId", () =>
          HttpResponse.json({ ok: false, error: "contact_not_found" }, { status: 404 }),
        ),
      ],
    },
  },
};

export const Error: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/contacts/:contactId", () =>
          HttpResponse.json({ ok: false, error: "internal" }, { status: 500 }),
        ),
      ],
    },
  },
};
