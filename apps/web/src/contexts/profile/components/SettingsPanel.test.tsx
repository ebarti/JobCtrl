import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  sampleHealthResponse,
  sampleSettingsResponse,
} from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { SettingsPanel } from "./SettingsPanel.js";

describe("<SettingsPanel>", () => {
  it("renders Temporal activity concurrency from worker health", async () => {
    renderWithProviders(<SettingsPanel />, {
      ports: buildTestPorts({
        api: {
          settings: vi.fn(async () => sampleSettingsResponse),
          health: vi.fn(async () => ({
            ...sampleHealthResponse,
            worker: {
              ...sampleHealthResponse.worker,
              heartbeat: {
                ...sampleHealthResponse.worker.heartbeat!,
                maxConcurrentActivities: 12,
                activityExecutorMaxWorkers: 14,
              },
            },
          })),
        },
      }),
    });

    expect(await screen.findByText("Temporal runtime")).toBeInTheDocument();
    expect(screen.getByText("Activity slots")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("Executor threads")).toBeInTheDocument();
    expect(screen.getByText("14")).toBeInTheDocument();
    expect(
      screen.getByText("JOBHUNTER_MAX_CONCURRENT_ACTIVITIES"),
    ).toBeInTheDocument();
  });
});
