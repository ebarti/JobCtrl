import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";

import {
  pipelinesCalibratingSnapshot,
  pipelinesCompletedSnapshot,
  pipelinesCompletedWithIssuesSnapshot,
  pipelinesDiscoveringSnapshot,
  pipelinesDrainingSnapshot,
  pipelinesMultiWorkerCapacitySnapshot,
  pipelinesThreeSourceSixStepSnapshot,
  pipelinesUnavailableTelemetrySnapshot,
} from "./PipelinesView.fixtures.js";
import { PipelinesView } from "./PipelinesView.js";

const meta = {
  title: "Views/Pipelines/PipelinesView",
  component: PipelinesView,
  parameters: {
    withRouter: true,
    initialPath: "/pipelines",
  },
} satisfies Meta<typeof PipelinesView>;

export default meta;
type Story = StoryObj<typeof meta>;

function operationsSnapshot(snapshot: typeof pipelinesDiscoveringSnapshot) {
  return http.get("*/v1/pipeline/operations", () => HttpResponse.json(snapshot));
}

export const Discovering: Story = {
  parameters: {
    msw: { handlers: [operationsSnapshot(pipelinesDiscoveringSnapshot)] },
  },
};

export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/v1/pipeline/operations", async () => {
          await new Promise((resolve) => setTimeout(resolve, 60_000));
          return HttpResponse.json(pipelinesDiscoveringSnapshot);
        }),
      ],
    },
  },
};

export const Draining: Story = {
  parameters: {
    msw: { handlers: [operationsSnapshot(pipelinesDrainingSnapshot)] },
  },
};

export const Completed: Story = {
  parameters: {
    msw: { handlers: [operationsSnapshot(pipelinesCompletedSnapshot)] },
  },
};

export const CompletedWithIssuesAndStaleTelemetry: Story = {
  parameters: {
    msw: { handlers: [operationsSnapshot(pipelinesCompletedWithIssuesSnapshot)] },
  },
};

export const CalibratingEta: Story = {
  parameters: {
    msw: { handlers: [operationsSnapshot(pipelinesCalibratingSnapshot)] },
  },
};

export const UnavailableTelemetryAndEta: Story = {
  parameters: {
    msw: { handlers: [operationsSnapshot(pipelinesUnavailableTelemetrySnapshot)] },
  },
};

export const MultiWorkerCapacity: Story = {
  parameters: {
    msw: { handlers: [operationsSnapshot(pipelinesMultiWorkerCapacitySnapshot)] },
  },
};

export const ThreeSourceSixStepRegression: Story = {
  parameters: {
    msw: { handlers: [operationsSnapshot(pipelinesThreeSourceSixStepSnapshot)] },
  },
};
