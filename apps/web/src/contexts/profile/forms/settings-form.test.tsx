import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sampleSettingsResponse } from "../../../test/fixtures/projections.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { renderWithProviders } from "../../../test/render.js";
import {
  DiscoveryAutomationSettingsForm,
  SettingsForm,
} from "./settings-form.js";
import type { SettingsResponse } from "../../operations/types.js";

describe("<SettingsForm>", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders Settings as execution-only config", () => {
    const { container } = renderWithProviders(<SettingsForm initial={sampleSettingsResponse.settings} />);

    expect(screen.getByLabelText("Apply concurrency")).toHaveValue(2);
    expect(screen.queryByLabelText("Minimum fit score")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Target role")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Auto apply")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Scoring rubric" })).not.toBeInTheDocument();
    expect(screen.queryByText("Exclusions")).not.toBeInTheDocument();
    expect(container.querySelector("textarea")).not.toBeInTheDocument();
  });

  it("autosaves execution settings after five seconds", async () => {
    vi.useFakeTimers();
    const updateSettings = vi.fn(async (request): Promise<SettingsResponse> => ({
      ok: true,
      settings: { ...sampleSettingsResponse.settings, ...request },
      paths: sampleSettingsResponse.paths,
    }));
    renderWithProviders(<SettingsForm initial={sampleSettingsResponse.settings} />, {
      ports: buildTestPorts({ api: { updateSettings } }),
    });

    fireEvent.change(screen.getByLabelText("Apply concurrency"), {
      target: { value: "4" },
    });

    act(() => vi.advanceTimersByTime(4_999));
    expect(updateSettings).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });

    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith({ applyConcurrency: 4 });
  });

  it("keeps newer execution edits when an autosave response returns for an older snapshot", async () => {
    vi.useFakeTimers();
    let resolveUpdate: ((response: SettingsResponse) => void) | undefined;
    const updateSettings = vi.fn(
      (request) =>
        new Promise<SettingsResponse>((resolve) => {
          void request;
          resolveUpdate = resolve;
        }),
    );
    renderWithProviders(<SettingsForm initial={sampleSettingsResponse.settings} />, {
      ports: buildTestPorts({ api: { updateSettings } }),
    });

    const applyConcurrency = screen.getByLabelText("Apply concurrency");
    fireEvent.change(applyConcurrency, {
      target: { value: "3" },
    });

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(updateSettings).toHaveBeenCalledTimes(1);

    fireEvent.change(applyConcurrency, {
      target: { value: "5" },
    });
    const request = updateSettings.mock.calls[0]?.[0];
    await act(async () => {
      resolveUpdate?.({
        ok: true,
        settings: { ...sampleSettingsResponse.settings, ...request },
        paths: sampleSettingsResponse.paths,
      });
      await Promise.resolve();
    });

    expect(applyConcurrency).toHaveValue(5);
    expect(screen.getByText("saved; newer changes pending")).toBeInTheDocument();
  });
});

describe("<DiscoveryAutomationSettingsForm>", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders Discovery automation controls without duplicated targeting filters", () => {
    const { container } = renderWithProviders(
      <DiscoveryAutomationSettingsForm initial={sampleSettingsResponse.settings} />,
    );

    expect(screen.getByLabelText("Minimum fit score")).toHaveValue(7);
    expect(screen.getByLabelText("Auto apply")).not.toBeChecked();
    expect(screen.queryByLabelText("Apply concurrency")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Target role")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Scoring rubric" })).not.toBeInTheDocument();
    expect(screen.queryByText("Ranking priorities")).not.toBeInTheDocument();
    expect(screen.queryByText("Exclusions")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Exclude onsite-only")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Exclude junior roles")).not.toBeInTheDocument();
    expect(container.querySelector("textarea")).not.toBeInTheDocument();
  });

  it("saves automation settings as a partial settings update", async () => {
    const updateSettings = vi.fn(async (request): Promise<SettingsResponse> => ({
      ok: true,
      settings: { ...sampleSettingsResponse.settings, ...request },
      paths: sampleSettingsResponse.paths,
    }));
    renderWithProviders(<DiscoveryAutomationSettingsForm initial={sampleSettingsResponse.settings} />, {
      ports: buildTestPorts({ api: { updateSettings } }),
    });

    fireEvent.change(screen.getByLabelText("Minimum fit score"), {
      target: { value: "9" },
    });
    fireEvent.click(screen.getByLabelText("Auto apply"));
    fireEvent.click(screen.getByRole("button", { name: /^save automation settings$/i }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings).toHaveBeenCalledWith({ autoApply: true, minFitScore: 9 });
  });

  it("undos automation checkbox changes with the keyboard shortcut", async () => {
    renderWithProviders(<DiscoveryAutomationSettingsForm initial={sampleSettingsResponse.settings} />);

    const autoApply = screen.getByLabelText("Auto apply");
    fireEvent.click(autoApply);
    await waitFor(() => expect(autoApply).toBeChecked());

    fireEvent.keyDown(autoApply, { key: "z", metaKey: true });

    await waitFor(() => expect(autoApply).not.toBeChecked());
  });
});
