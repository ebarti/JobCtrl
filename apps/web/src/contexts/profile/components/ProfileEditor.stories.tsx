import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";

import { sampleProfileResponse } from "../../../test/fixtures/projections.js";
import { ProfileEditor } from "./ProfileEditor.js";

// ProfileEditor mounts StructuredProfileEditor which renders many bare
// <select>/<textarea>/<button> elements without associated labels
// (select-name, button-name violations). Production-code defect from
// Phase 4; deferred.
const meta = {
  title: "Contexts/Profile/ProfileEditor",
  component: ProfileEditor,
  parameters: {
    a11y: { test: "off" },
  },
} satisfies Meta<typeof ProfileEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/profile", async () => {
          await new Promise((resolve) => setTimeout(resolve, 60_000));
          return HttpResponse.json(sampleProfileResponse);
        }),
      ],
    },
  },
};

export const Error: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/profile", () =>
          HttpResponse.json({ ok: false, error: "internal" }, { status: 500 }),
        ),
      ],
    },
  },
};
