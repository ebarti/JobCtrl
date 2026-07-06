import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";

import { sampleDailyDigest } from "../../test/fixtures/projections.js";
import { DigestPanel } from "./DigestPanel.js";

const meta = {
  title: "Views/Dashboard/DigestPanel",
  component: DigestPanel,
} satisfies Meta<typeof DigestPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/digest", () =>
          HttpResponse.json({
            ...sampleDailyDigest,
            since: null,
            newMatches: { count: 0, highFitCount: 0 },
            blockedSources: { count: 0, sources: [] },
            reviewNeededMaterials: { count: 0 },
            staleScores: { count: 0 },
            pendingApprovals: { count: 0 },
            followUpsDue: { ...sampleDailyDigest.followUpsDue, count: 0 },
            budget: { ...sampleDailyDigest.budget, status: "ok", estimatedUsd: 1.5, remainingUsd: 8.5 },
          }),
        ),
      ],
    },
  },
};

export const Error: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/digest", () =>
          HttpResponse.json({ ok: false, error: "digest unavailable" }, { status: 500 }),
        ),
      ],
    },
  },
};
