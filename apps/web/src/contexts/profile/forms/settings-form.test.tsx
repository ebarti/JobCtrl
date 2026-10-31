import { http, HttpResponse } from "msw";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  sampleDiscoverySettingsResponse,
  sampleSettingsResponse,
} from "../../../test/fixtures/projections.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { createTestQueryClient, renderWithProviders } from "../../../test/render.js";
import { server } from "../../../test/msw/server.js";
import { useSettingsQuery } from "../hooks/useSettingsQuery.js";
import { profileKeys } from "../queryKeys.js";
import {
  SettingsForm,
} from "./settings-form.js";
import type { SettingsResponse, SettingsUpdateRequest } from "@jobctrl/contracts";
import { DiscoveryAutomationSettingsForm } from "../../discovery/components/DiscoveryAutomationSettingsPanel.js";
import type { DiscoverySettingsResponse } from "@jobctrl/contracts";

function SettingsQueryHost() {
  const settings = useSettingsQuery().data;
  return settings ? <SettingsForm initial={settings.settings} effectiveSettings={settings.effectiveSettings} /> : null;
}

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
    expect(screen.getByLabelText("Pipeline internal concurrency")).toHaveValue(3);
    expect(screen.getByLabelText("Worker activity slots")).toHaveValue(4);
    expect(screen.getByLabelText("Daily LLM budget (USD)")).toHaveValue(25);
    expect(screen.queryByLabelText("Minimum fit score")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Target role")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Auto apply")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Scoring rubric" })).not.toBeInTheDocument();
    expect(screen.queryByText("Exclusions")).not.toBeInTheDocument();
    expect(container.querySelector("textarea")).not.toBeInTheDocument();
  });

  it("uses shared field, input, and action primitives", () => {
    const { container } = renderWithProviders(
      <SettingsForm
        initial={sampleSettingsResponse.settings}
        effectiveSettings={sampleSettingsResponse.effectiveSettings}
      />,
    );

    expect(container.querySelectorAll('[data-slot="field"]')).toHaveLength(4);
    expect(container.querySelectorAll('input[data-slot="input"]')).toHaveLength(4);
    expect(screen.getByLabelText("Daily LLM budget (USD)")).toHaveAttribute(
      "data-slot",
      "input",
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveAttribute(
      "data-slot",
      "button",
    );
    expect(screen.getByRole("button", { name: "Discard changes" })).toHaveAttribute(
      "data-slot",
      "button",
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard changes" })).toBeDisabled();
    expect(container.querySelector(".settings-save-actions")).toHaveAttribute("data-save-state", "saved");
  });

  it("links every execution setting to its owning documentation", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <SettingsForm
        initial={sampleSettingsResponse.settings}
        effectiveSettings={sampleSettingsResponse.effectiveSettings}
      />,
    );

    for (const title of [
      "Daily LLM budget",
      "Concurrent applications",
      "Pipeline internal concurrency",
      "Worker activity slots",
    ]) {
      expect(
        screen.getByRole("button", { name: `Help for ${title}` }),
      ).toBeInTheDocument();
    }

    await user.click(
      screen.getByRole("button", { name: "Help for Worker activity slots" }),
    );
    expect(screen.getByRole("link", { name: "Open documentation" })).toHaveAttribute(
      "href",
      "https://jobctrl.dev/user/configuration#runtime-setting-worker-activity-slots",
    );
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
      pipelineInternalConcurrency: 3,
      workerActivitySlots: 4,
    });
  });

  it("keeps a rejected settings draft without repeated autosaves and retries after a new edit", async () => {
    vi.useFakeTimers();
    let fail = true;
    let saved = structuredClone(sampleSettingsResponse);
    const updateSettings = vi.fn(async (request: SettingsUpdateRequest): Promise<SettingsResponse> => {
      if (fail) throw new Error("Synthetic settings save failed");
      saved = {
        ok: true,
        settings: { ...saved.settings, applyConcurrency: request.applyConcurrency ?? saved.settings.applyConcurrency },
        effectiveSettings: sampleSettingsResponse.effectiveSettings,
        paths: sampleSettingsResponse.paths,
      };
      return saved;
    });
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(profileKeys.settings(LOCAL_TENANT), saved);
    renderWithProviders(<SettingsQueryHost />, {
      queryClient,
      ports: buildTestPorts({ api: { updateSettings, settings: async () => saved } }),
    });

    const concurrency = screen.getByLabelText("Concurrent applications");
    fireEvent.change(concurrency, { target: { value: "3" } });
    for (let period = 0; period < 4; period++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    }
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(concurrency).toHaveValue(3);
    expect(screen.getByText("Could not save settings. Review the fields and try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();

    fail = false;
    fireEvent.change(concurrency, { target: { value: "5" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(updateSettings).toHaveBeenCalledTimes(2);
    expect(updateSettings.mock.calls[1]![0].applyConcurrency).toBe(5);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(concurrency).toHaveValue(5);
    expect(screen.getByText("Settings saved.")).toBeInTheDocument();
  });

  it("does not autosave an unchanged draft after a failed manual save, and resets the attempt on discard", async () => {
    vi.useFakeTimers();
    const updateSettings = vi.fn(async () => { throw new Error("Synthetic settings save failed"); });
    renderWithProviders(<SettingsForm
      initial={sampleSettingsResponse.settings}
      effectiveSettings={sampleSettingsResponse.effectiveSettings}
    />, { ports: buildTestPorts({ api: { updateSettings } }) });

    const concurrency = screen.getByLabelText("Concurrent applications");
    fireEvent.change(concurrency, { target: { value: "3" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    for (let period = 0; period < 4; period++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    }
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(concurrency).toHaveValue(3);
    expect(screen.getByText("Could not save settings. Review the fields and try again.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(concurrency).toHaveValue(2);
    fireEvent.change(concurrency, { target: { value: "3" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(updateSettings).toHaveBeenCalledTimes(2);
  });

  it("does not overlap a delayed failed autosave and saves newer settings", async () => {
    vi.useFakeTimers();
    let rejectFirst: ((error: Error) => void) | undefined;
    let saved = structuredClone(sampleSettingsResponse);
    const updateSettings = vi.fn()
      .mockImplementationOnce(() => new Promise<SettingsResponse>((_resolve, reject) => {
        rejectFirst = reject;
      }))
      .mockImplementationOnce(async (request: SettingsUpdateRequest) => {
        saved = {
          ok: true,
          settings: { ...saved.settings, applyConcurrency: request.applyConcurrency ?? saved.settings.applyConcurrency },
          effectiveSettings: sampleSettingsResponse.effectiveSettings,
          paths: sampleSettingsResponse.paths,
        };
        return saved;
      });
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(profileKeys.settings(LOCAL_TENANT), saved);
    renderWithProviders(<SettingsQueryHost />, {
      queryClient,
      ports: buildTestPorts({ api: { updateSettings, settings: async () => saved } }),
    });

    const concurrency = screen.getByLabelText("Concurrent applications");
    fireEvent.change(concurrency, { target: { value: "3" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(updateSettings).toHaveBeenCalledTimes(1);
    fireEvent.change(concurrency, { target: { value: "5" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(concurrency).toHaveValue(5);

    await act(async () => {
      rejectFirst?.(new Error("Synthetic delayed settings failure"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(concurrency).toHaveValue(5);
    expect(screen.getByText("Could not save settings. Review the fields and try again.")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(updateSettings).toHaveBeenCalledTimes(2);
    expect(updateSettings.mock.calls[1]![0].applyConcurrency).toBe(5);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(concurrency).toHaveValue(5);
    expect(screen.getByText("Settings saved.")).toBeInTheDocument();
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
    expect(screen.getByText("Saved; newer changes pending.")).toBeInTheDocument();
  });

  it("keeps newer typing and the canonical settings when an older save and refresh fail", async () => {
    let releaseWrite!: () => void;
    let writes = 0;
    let reads = 0;
    server.use(
      http.patch("*/v1/settings", async () => {
        writes += 1;
        await new Promise<void>((resolve) => { releaseWrite = resolve; });
        return HttpResponse.json({ ok: false }, { status: 500 });
      }),
      http.get("*/v1/settings", () => {
        reads += 1;
        return HttpResponse.json({ ok: false }, { status: 500 });
      }),
    );
    const queryClient = createTestQueryClient();
    const key = profileKeys.settings(LOCAL_TENANT);
    queryClient.setQueryData(key, sampleSettingsResponse);
    function QueryBackedSettings() {
      const query = useSettingsQuery();
      return query.data ? <SettingsForm initial={query.data.settings}
        effectiveSettings={query.data.effectiveSettings} /> : null;
    }
    renderWithProviders(<QueryBackedSettings />, { queryClient });
    const budget = screen.getByLabelText("Daily LLM budget (USD)");
    fireEvent.change(budget, { target: { value: "40" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(writes).toBe(1));
    fireEvent.change(budget, { target: { value: "45" } });
    const newer = {
      ...sampleSettingsResponse,
      settings: { ...sampleSettingsResponse.settings, dailyBudgetUsd: 60, applyConcurrency: 5 },
      effectiveSettings: {
        ...sampleSettingsResponse.effectiveSettings,
        dailyBudgetUsd: { ...sampleSettingsResponse.effectiveSettings.dailyBudgetUsd, value: 60 },
        applyConcurrency: { ...sampleSettingsResponse.effectiveSettings.applyConcurrency, value: 5 },
      },
    };
    act(() => queryClient.setQueryData(key, newer));
    act(() => releaseWrite());
    expect(await screen.findByText("Could not save settings. Review the fields and try again.")).toBeInTheDocument();
    await waitFor(() => expect(reads).toBeGreaterThan(0));
    await waitFor(() => expect(queryClient.getQueryState(key)?.status).toBe("error"));
    expect(queryClient.getQueryData(key)).toEqual(newer);
    expect(budget).toHaveValue(45);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("keeps the saved worker value editable and reports restart state", async () => {
    const effectiveSettings = {
      ...sampleSettingsResponse.effectiveSettings,
      workerActivitySlots: {
        value: 9,
        source: "persisted",
        activation: "restart",
        editable: true,
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

    expect(screen.getByLabelText("Worker activity slots")).not.toHaveAttribute("readonly");
    expect(screen.getByText(/Saved in config.json; requires a worker restart/)).toBeInTheDocument();
    expect(screen.getByText(/Restart pending/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Daily LLM budget (USD)"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ workerActivitySlots: 9 }));
  });
});

describe("<DiscoveryAutomationSettingsForm>", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders Discovery automation controls without duplicated targeting filters", () => {
    const { container } = renderWithProviders(
      <DiscoveryAutomationSettingsForm initial={sampleDiscoverySettingsResponse} />,
    );

    expect(screen.getByLabelText("Minimum fit score")).toHaveValue(7);
    expect(screen.getByRole("checkbox", { name: "Auto apply" })).not.toBeChecked();
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
    const updateDiscoverySettings = vi.fn(async (request): Promise<DiscoverySettingsResponse> => ({
      ok: true,
      settings: { ...sampleDiscoverySettingsResponse.settings, ...request },
      effectiveSettings: sampleDiscoverySettingsResponse.effectiveSettings,
    }));
    renderWithProviders(<DiscoveryAutomationSettingsForm initial={sampleDiscoverySettingsResponse} />, {
      ports: buildTestPorts({ api: { updateDiscoverySettings } }),
    });

    fireEvent.change(screen.getByLabelText("Minimum fit score"), {
      target: { value: "9" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Auto apply" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(updateDiscoverySettings).toHaveBeenCalledTimes(1));
    expect(updateDiscoverySettings).toHaveBeenCalledWith({
      autoApply: true,
      applyApprovalRequired: true,
      minFitScore: 9,
    });
  });

  it("keeps a failed automation draft visible without repeating its autosave", async () => {
    vi.useFakeTimers();
    const updateDiscoverySettings = vi.fn(async () => {
      throw new Error("Synthetic automation save failed");
    });
    renderWithProviders(<DiscoveryAutomationSettingsForm initial={sampleDiscoverySettingsResponse} />, {
      ports: buildTestPorts({ api: { updateDiscoverySettings } }),
    });

    const minimumScore = screen.getByLabelText("Minimum fit score");
    fireEvent.change(minimumScore, { target: { value: "9" } });
    for (let period = 0; period < 4; period++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    }
    expect(updateDiscoverySettings).toHaveBeenCalledTimes(1);
    expect(minimumScore).toHaveValue(9);
    expect(screen.getByText("Synthetic automation save failed")).toBeInTheDocument();
    expect(screen.getByText("Could not autosave changes. Your draft is still unsaved; try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("warns when live apply approval is disabled", async () => {
    renderWithProviders(<DiscoveryAutomationSettingsForm initial={sampleDiscoverySettingsResponse} />);

    fireEvent.click(
      screen.getByRole("checkbox", { name: /Require approval before live submit/i }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Auto apply is off. Manually started live claims skip the Apply Review gate, but browser final submit stays manual and email sends still require exact approval.",
    );
  });

  it("describes supervised and approval-disabled auto-apply combinations", async () => {
    renderWithProviders(<DiscoveryAutomationSettingsForm initial={sampleDiscoverySettingsResponse} />);

    expect(screen.getByRole("status", { name: "Automation policy summary" })).toHaveTextContent(
      "Default supervised mode: no standing apply loop runs, live claims require Apply Review approval, and browser final submit stays manual.",
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Auto apply" }));
    expect(screen.getByRole("status", { name: "Automation policy summary" })).toHaveTextContent(
      "Auto apply is supervised: the standing loop polls eligible jobs, browser forms stop for manual completion, and exact-approved email applications may use the owned sender.",
    );

    fireEvent.click(
      screen.getByRole("checkbox", { name: /Require approval before live submit/i }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Approval gate is off: the standing loop may claim eligible jobs without review, but browser final submit stays manual and the owned email sender still requires exact approval.",
    );
  });

  it("undos automation checkbox changes with the keyboard shortcut", async () => {
    renderWithProviders(<DiscoveryAutomationSettingsForm initial={sampleDiscoverySettingsResponse} />);

    const autoApply = screen.getByRole("checkbox", { name: "Auto apply" });
    fireEvent.click(autoApply);
    await waitFor(() => expect(autoApply).toBeChecked());

    fireEvent.keyDown(autoApply, { key: "z", metaKey: true });

    await waitFor(() => expect(autoApply).not.toBeChecked());
  });
});
