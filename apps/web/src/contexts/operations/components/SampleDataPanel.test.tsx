import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { SampleDataPanel } from "./SampleDataPanel.js";

const emptyStatus = {
  ok: true as const,
  state: "empty" as const,
  dbExists: true,
  canLoad: true,
  canClear: false,
  jobCount: 0,
  sampleJobCount: 0,
  loadedAt: null,
  sampleJobs: [],
  message: "This empty workspace can load JobHunter sample data.",
};

const loadedStatus = {
  ...emptyStatus,
  state: "loaded" as const,
  canLoad: false,
  canClear: true,
  jobCount: 2,
  sampleJobCount: 2,
  loadedAt: "2026-07-06T10:00:00.000Z",
  sampleJobs: [
    {
      jobKey: "https://sample.jobhunter.local/jobs/platform-engineering-director",
      title: "Director of Platform Engineering",
      company: "Northstar Robotics",
      fitScore: 9,
      hasPdf: true,
    },
  ],
  message: "Sample data is loaded. Clear it before starting real job discovery.",
};

describe("<SampleDataPanel>", () => {
  it("loads sample data from an empty workspace", async () => {
    const user = userEvent.setup();
    const loadSampleData = vi.fn(async () => ({
      ok: true as const,
      loaded: true,
      cleared: false,
      status: loadedStatus,
      message: "Sample data loaded.",
    }));
    renderWithProviders(<SampleDataPanel />, {
      ports: buildTestPorts({
        api: {
          sampleDataStatus: vi.fn(async () => emptyStatus),
          loadSampleData,
        },
      }),
    });

    expect(await screen.findByRole("heading", { name: "Load first-run sample data" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "load sample data" }));

    expect(loadSampleData).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Sample data loaded.")).toBeInTheDocument();
  });

  it("requires confirmation before clearing loaded sample data", async () => {
    const user = userEvent.setup();
    const clearSampleData = vi.fn(async () => ({
      ok: true as const,
      loaded: false,
      cleared: true,
      status: emptyStatus,
      message: "Sample data cleared.",
    }));
    renderWithProviders(<SampleDataPanel compact />, {
      ports: buildTestPorts({
        api: {
          sampleDataStatus: vi.fn(async () => loadedStatus),
          clearSampleData,
        },
      }),
    });

    expect(await screen.findByRole("heading", { name: "2 sample jobs loaded" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "clear sample data" }));
    expect(screen.getByRole("button", { name: "confirm clear sample data" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "cancel" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "confirm clear sample data" }));

    expect(clearSampleData).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Sample data cleared.")).toBeInTheDocument();
  });

  it("stays hidden when a workspace already has real jobs", async () => {
    const sampleDataStatus = vi.fn(async () => ({
      ...emptyStatus,
      state: "blocked" as const,
      canLoad: false,
      jobCount: 4,
      message: "Sample data can only be loaded into an empty workspace.",
    }));
    const { container } = renderWithProviders(<SampleDataPanel />, {
      ports: buildTestPorts({
        api: {
          sampleDataStatus,
        },
      }),
    });

    await waitFor(() => expect(sampleDataStatus).toHaveBeenCalledTimes(1));
    expect(container.querySelector(".sample-data-panel")).not.toBeInTheDocument();
  });
});
