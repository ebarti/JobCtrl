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
    const { container } = renderWithProviders(
      <SettingsForm
        initial={sampleSettingsResponse.settings}
        effectiveSettings={sampleSettingsResponse.effectiveSettings}
        activeWorkerActivitySlots={4}
        workerStatus="healthy"
      />,
    );

    expect(screen.getByLabelText("Concurrent applications")).toHaveValue(2);
    expect(screen.getByLabelText("Worker activity slots")).toHaveValue(4);
    expect(screen.getByLabelText("Daily LLM budget (USD)")).toHaveValue(25);
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
      effectiveSettings: sampleSettingsResponse.effectiveSettings,
      paths: sampleSettingsResponse.paths,
    }));
    renderWithProviders(<SettingsForm
      initial={sampleSettingsResponse.settings}
      effectiveSettings={sampleSettingsResponse.effectiveSettings}
    />, {
      ports: buildTestPorts({ api: { updateSettings } }),
    });

    fireEvent.change(screen.getByLabelText("Concurrent applications"), {
      target: { value: "4" },
    });

    act(() => vi.advanceTimersByTime(4_999));
    expect(updateSettings).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });

    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith({
      applyConcurrency: 4,
      dailyBudgetUsd: 25,
      workerActivitySlots: 4,
    });
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
    renderWithProviders(<SettingsForm
      initial={sampleSettingsResponse.settings}
      effectiveSettings={sampleSettingsResponse.effectiveSettings}
    />, {
      ports: buildTestPorts({ api: { updateSettings } }),
    });

    const applyConcurrency = screen.getByLabelText("Concurrent applications");
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
        effectiveSettings: sampleSettingsResponse.effectiveSettings,
        paths: sampleSettingsResponse.paths,
      });
      await Promise.resolve();
    });

    expect(applyConcurrency).toHaveValue(5);
    expect(screen.getByText("saved; newer changes pending")).toBeInTheDocument();
  });

  it("keeps an environment-managed worker value read-only and out of submissions", async () => {
    const effectiveSettings = {
      ...sampleSettingsResponse.effectiveSettings,
      workerActivitySlots: {
        value: 9,
        source: "environment",
        activation: "restart",
        editable: false,
      } as const,
    };
    const updateSettings = vi.fn(async (): Promise<SettingsResponse> => ({
      ...sampleSettingsResponse,
      settings: { ...sampleSettingsResponse.settings, workerActivitySlots: 9 },
      effectiveSettings,
    }));
    renderWithProviders(
      <SettingsForm
        initial={{ ...sampleSettingsResponse.settings, workerActivitySlots: 9 }}
        effectiveSettings={effectiveSettings}
        activeWorkerActivitySlots={4}
        workerStatus="healthy"
      />,
      { ports: buildTestPorts({ api: { updateSettings } }) },
    );

    expect(screen.getByLabelText("Worker activity slots")).toHaveAttribute("readonly");
    expect(screen.getByText(/Managed by the launch environment/)).toBeInTheDocument();
    expect(screen.getByText(/Restart pending/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Daily LLM budget (USD)"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings.mock.calls[0]?.[0]).not.toHaveProperty("workerActivitySlots");
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
    expect(screen.queryByLabelText("Concurrent applications")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Daily LLM budget (USD)")).not.toBeInTheDocument();
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
      effectiveSettings: sampleSettingsResponse.effectiveSettings,
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
    expect(updateSettings).toHaveBeenCalledWith({
      autoApply: true,
      applyApprovalRequired: true,
      minFitScore: 9,
    });
  });

  it("warns when live apply approval is disabled", async () => {
    renderWithProviders(<DiscoveryAutomationSettingsForm initial={sampleSettingsResponse.settings} />);

    fireEvent.click(
      screen.getByRole("checkbox", { name: /Require approval before live submit/i }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Auto apply is off. Manually started live apply runs may submit without Apply Review approval.",
    );
  });

  it("describes supervised and autonomous auto-apply combinations", async () => {
    renderWithProviders(<DiscoveryAutomationSettingsForm initial={sampleSettingsResponse.settings} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Default supervised mode: no standing apply loop runs, and live submit requires Apply Review approval.",
    );

    fireEvent.click(screen.getByLabelText("Auto apply"));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Auto apply is supervised: a standing loop polls eligible jobs, and live submit waits for Apply Review approval.",
    );

    fireEvent.click(
      screen.getByRole("checkbox", { name: /Require approval before live submit/i }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Autonomous submit mode: the standing loop may submit eligible jobs without human review",
    );
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
