import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { sampleDiscoverySettingsResponse } from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { DiscoveryRuntimeSettingsPanel } from "./DiscoveryRuntimeSettingsPanel.js";

describe("<DiscoveryRuntimeSettingsPanel>", () => {
  it("renders the effective discovery controls with truthful activation", async () => {
    renderWithProviders(<DiscoveryRuntimeSettingsPanel />);

    expect(await screen.findByRole("group", { name: "Role title filtering" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Auto/ })).toBeChecked();
    expect(screen.getByLabelText("Parallel source families")).toHaveValue(1);
    expect(screen.getByLabelText("Crawler product name")).toHaveValue("JobCtrl");
    expect(screen.getAllByText(/requires a worker restart/).length).toBeGreaterThan(0);
  });

  it("keeps environment-managed controls read-only and out of writes", async () => {
    const user = userEvent.setup();
    const managed = {
      ...sampleDiscoverySettingsResponse,
      settings: { ...sampleDiscoverySettingsResponse.settings, maxParallelFamilies: 4 },
      effectiveSettings: {
        ...sampleDiscoverySettingsResponse.effectiveSettings,
        maxParallelFamilies: {
          value: 4,
          source: "environment" as const,
          activation: "next_run" as const,
          editable: false as const,
        },
      },
    };
    const updateDiscoverySettings = vi.fn(async () => managed);
    renderWithProviders(<DiscoveryRuntimeSettingsPanel />, {
      ports: buildTestPorts({ api: {
        discoverySettings: vi.fn(async () => managed),
        updateDiscoverySettings,
      } }),
    });

    expect(await screen.findByLabelText("Parallel source families")).toHaveAttribute("readonly");
    await user.clear(screen.getByLabelText("Results per board"));
    await user.type(screen.getByLabelText("Results per board"), "25");
    await user.click(screen.getByRole("button", { name: "save runtime settings" }));

    await waitFor(() => expect(updateDiscoverySettings).toHaveBeenCalledTimes(1));
    expect(updateDiscoverySettings.mock.calls[0]?.[0]).not.toHaveProperty("maxParallelFamilies");
  });

  it("announces restart pending after saving schedule changes", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DiscoveryRuntimeSettingsPanel />);

    await user.click(await screen.findByLabelText("Enable scheduled discovery"));
    await user.click(screen.getByRole("button", { name: "save runtime settings" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Restart pending");
  });
});
