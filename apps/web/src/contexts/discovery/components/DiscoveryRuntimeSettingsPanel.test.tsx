import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { sampleDiscoverySettingsResponse } from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { DiscoveryRuntimeSettingsPanel } from "./DiscoveryRuntimeSettingsPanel.js";

describe("<DiscoveryRuntimeSettingsPanel>", () => {
  it("explains every runtime setting without repeating persistence metadata", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DiscoveryRuntimeSettingsPanel />);

    expect(await screen.findByRole("spinbutton", { name: "Results per board" })).toHaveValue(50);
    expect(screen.getByLabelText("Parallel source families")).toHaveValue(1);
    expect(screen.getByRole("checkbox", { name: "Use browser headers" })).not.toBeChecked();
    expect(screen.queryByLabelText("Crawler product name")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Crawler contact")).not.toBeInTheDocument();
    expect(screen.queryByText(/Saved in SQLite/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/applies to the next/i)).not.toBeInTheDocument();

    const settingNames = [
      "Job boards",
      "Results per board",
      "Posting lookback hours",
      "Parallel source families",
      "Use browser headers",
      "Enable scheduled discovery",
      "Schedule cron",
    ];
    for (const settingName of settingNames) {
      expect(
        screen.getByRole("button", { name: `Help for ${settingName}` }),
      ).toBeInTheDocument();
    }
    expect(
      screen.getByRole("spinbutton", { name: "Results per board" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Help for Schedule cron" }));
    const help = await screen.findByRole("dialog", { name: "Schedule cron help" });
    expect(within(help).getByText(/five-field cron expression/i)).toBeInTheDocument();
    expect(within(help).getByRole("link", { name: /Open documentation/i })).toHaveAttribute(
      "href",
      "https://jobctrl.dev/user/discovery#runtime-setting-schedule-cron",
    );
  });

  it("keeps SQLite-owned controls editable and includes changed values in writes", async () => {
    const user = userEvent.setup();
    const managed = {
      ...sampleDiscoverySettingsResponse,
      settings: { ...sampleDiscoverySettingsResponse.settings, maxParallelFamilies: 4 },
      effectiveSettings: {
        ...sampleDiscoverySettingsResponse.effectiveSettings,
        maxParallelFamilies: {
          value: 4,
          source: "persisted" as const,
          activation: "next_run" as const,
          editable: true as const,
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

    expect(await screen.findByLabelText("Parallel source families")).not.toHaveAttribute("readonly");
    await user.clear(screen.getByLabelText("Results per board"));
    await user.type(screen.getByLabelText("Results per board"), "25");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(updateDiscoverySettings).toHaveBeenCalledTimes(1));
    expect(updateDiscoverySettings).toHaveBeenCalledWith(
      expect.objectContaining({ maxParallelFamilies: 4 }),
    );
  });

  it("discards and saves the browser-header choice without overwriting the legacy identity", async () => {
    const user = userEvent.setup();
    let saved = sampleDiscoverySettingsResponse;
    const updateDiscoverySettings = vi.fn(async (body) => {
      saved = {
        ...saved,
        settings: { ...saved.settings, useBrowserHeaders: body.useBrowserHeaders },
        effectiveSettings: {
          ...saved.effectiveSettings,
          useBrowserHeaders: { ...saved.effectiveSettings.useBrowserHeaders, value: body.useBrowserHeaders },
        },
      };
      return saved;
    });
    renderWithProviders(<DiscoveryRuntimeSettingsPanel />, {
      ports: buildTestPorts({ api: {
        discoverySettings: vi.fn(async () => saved), updateDiscoverySettings,
      } }),
    });
    const checkbox = await screen.findByRole("checkbox", { name: "Use browser headers" });
    await user.click(checkbox);
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(checkbox).not.toBeChecked();
    expect(updateDiscoverySettings).not.toHaveBeenCalled();
    for (const enabled of [true, false]) {
      await user.click(checkbox);
      await user.click(screen.getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument());
      expect(updateDiscoverySettings).toHaveBeenLastCalledWith(expect.objectContaining({ useBrowserHeaders: enabled }));
      expect(updateDiscoverySettings.mock.lastCall?.[0]).not.toHaveProperty("crawlUserAgentProduct");
      expect(updateDiscoverySettings.mock.lastCall?.[0]).not.toHaveProperty("crawlUserAgentContact");
      expect(checkbox).toHaveAttribute("aria-checked", String(enabled));
    }
  });

  it("keeps the draft available and reports a failed save", async () => {
    const user = userEvent.setup();
    const updateDiscoverySettings = vi.fn(async () => { throw new Error("Synthetic save failed"); });
    renderWithProviders(<DiscoveryRuntimeSettingsPanel />, {
      ports: buildTestPorts({ api: { updateDiscoverySettings } }),
    });
    const checkbox = await screen.findByRole("checkbox", { name: "Use browser headers" });
    await user.click(checkbox);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Synthetic save failed");
    expect(checkbox).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(checkbox).not.toBeChecked();
  });

  it("announces restart pending after saving schedule changes", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DiscoveryRuntimeSettingsPanel />);

    await user.click(
      await screen.findByRole("checkbox", {
        name: "Enable scheduled discovery",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText(/Restart pending/)).toHaveAttribute(
      "role",
      "status",
    );
  });

  it("uses shared controls and shows save actions only for pending changes", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DiscoveryRuntimeSettingsPanel />);

    const resultsPerBoard = await screen.findByLabelText("Results per board");

    expect(resultsPerBoard).toHaveAttribute("data-slot", "input");
    expect(screen.getByRole("checkbox", { name: "Indeed" })).toHaveAttribute(
      "data-slot",
      "checkbox",
    );
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard changes" })).not.toBeInTheDocument();
    expect(screen.queryByText("No unsaved changes")).not.toBeInTheDocument();

    await user.clear(resultsPerBoard);
    await user.type(resultsPerBoard, "25");

    const save = screen.getByRole("button", { name: "Save changes" });
    const discard = screen.getByRole("button", { name: "Discard changes" });
    expect(save).toBeEnabled();
    expect(discard).toBeEnabled();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    await user.click(discard);
    expect(resultsPerBoard).toHaveValue(50);
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard changes" })).not.toBeInTheDocument();
  });
});
