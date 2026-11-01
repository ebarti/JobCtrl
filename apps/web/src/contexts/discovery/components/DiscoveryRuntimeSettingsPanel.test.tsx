import type { DiscoverySettingsResponse, DiscoverySettingsUpdateRequest } from "@jobctrl/contracts";
import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { act, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { sampleDiscoverySettingsResponse } from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { discoveryKeys } from "../queryKeys.js";
import { useUpdateDiscoverySettingsMutation } from "../hooks/useUpdateDiscoverySettingsMutation.js";
import { DiscoveryAutomationSettingsPanel } from "./DiscoveryAutomationSettingsPanel.js";
import { DiscoveryRuntimeSettingsPanel } from "./DiscoveryRuntimeSettingsPanel.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function discoveryResponse(
  resultsPerSite: number,
  hoursOld: number,
  boards = sampleDiscoverySettingsResponse.settings.boards,
  schedulingEnabled = false,
): DiscoverySettingsResponse {
  return {
    ...sampleDiscoverySettingsResponse,
    settings: { ...sampleDiscoverySettingsResponse.settings, resultsPerSite, hoursOld, boards, schedulingEnabled },
    effectiveSettings: {
      ...sampleDiscoverySettingsResponse.effectiveSettings,
      resultsPerSite: { ...sampleDiscoverySettingsResponse.effectiveSettings.resultsPerSite, value: resultsPerSite },
      hoursOld: { ...sampleDiscoverySettingsResponse.effectiveSettings.hoursOld, value: hoursOld },
      boards: { ...sampleDiscoverySettingsResponse.effectiveSettings.boards, value: boards },
      schedulingEnabled: { ...sampleDiscoverySettingsResponse.effectiveSettings.schedulingEnabled, value: schedulingEnabled },
    },
  };
}

function discoveryPatch(current: DiscoverySettingsResponse, body: DiscoverySettingsUpdateRequest): DiscoverySettingsResponse {
  return discoveryResponse(
    body.resultsPerSite ?? current.settings.resultsPerSite,
    body.hoursOld ?? current.settings.hoursOld,
    body.boards ?? current.settings.boards,
    body.schedulingEnabled ?? current.settings.schedulingEnabled,
  );
}

function AutomationSaveControl() {
  const update = useUpdateDiscoverySettingsMutation();
  return <>
    <button onClick={() => update.mutate({ autoApply: true })}>Save sibling automation</button>
    {update.error ? <span role="alert">{update.error.message}</span> : null}
  </>;
}

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
    expect(updateDiscoverySettings).toHaveBeenCalledWith({ resultsPerSite: 25 });
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

  it("rebases newer edits over the saved response and submits them on the next save", async () => {
    const user = userEvent.setup();
    const pending = deferred<DiscoverySettingsResponse>();
    let persisted = discoveryResponse(50, 72);
    const updateDiscoverySettings = vi.fn()
      .mockImplementationOnce(() => pending.promise)
      .mockImplementationOnce(async (body: DiscoverySettingsUpdateRequest) => {
        persisted = discoveryPatch(persisted, body);
        return persisted;
      });
    const { queryClient } = renderWithProviders(<DiscoveryRuntimeSettingsPanel />, {
      ports: buildTestPorts({ api: { discoverySettings: vi.fn(async () => persisted), updateDiscoverySettings } }),
    });
    const results = await screen.findByLabelText("Results per board");
    const hours = screen.getByLabelText("Posting lookback hours");
    await user.clear(results);
    await user.type(results, "25");
    await user.click(screen.getByRole("checkbox", { name: "Enable scheduled discovery" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateDiscoverySettings).toHaveBeenCalledTimes(1));
    expect(updateDiscoverySettings).toHaveBeenNthCalledWith(1, expect.objectContaining({ resultsPerSite: 25, schedulingEnabled: true }));

    await user.clear(results);
    await user.type(results, "30");
    await user.click(screen.getByRole("checkbox", { name: "Glassdoor" }));
    await act(async () => { await queryClient.refetchQueries(); });
    expect(results).toHaveValue(30);
    persisted = discoveryResponse(25, 48, sampleDiscoverySettingsResponse.settings.boards, true);
    await act(async () => pending.resolve(persisted));

    await screen.findByText(/Runtime settings saved/);
    expect(results).toHaveValue(30);
    expect(hours).toHaveValue(48);
    expect(screen.getByRole("checkbox", { name: "Glassdoor" })).toBeChecked();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(screen.getByText(/newer changes pending/i)).toHaveTextContent(/Restart pending/);
    await act(async () => { await queryClient.refetchQueries(); });
    expect(results).toHaveValue(30);
    expect(screen.getByRole("checkbox", { name: "Glassdoor" })).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateDiscoverySettings).toHaveBeenCalledTimes(2));
    expect(updateDiscoverySettings).toHaveBeenNthCalledWith(2, expect.objectContaining({
      resultsPerSite: 30,
      boards: ["indeed", "linkedin", "zip_recruiter", "glassdoor"],
    }));
    expect(updateDiscoverySettings.mock.calls[1]?.[0]).not.toHaveProperty("hoursOld");
    expect(updateDiscoverySettings.mock.calls[1]?.[0]).not.toHaveProperty("schedulingEnabled");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument());
    await user.clear(results);
    await user.type(results, "40");
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(results).toHaveValue(30);
  });

  it("retains edits after a failed pending save and adopts a later canonical response", async () => {
    const user = userEvent.setup();
    const pending = deferred<DiscoverySettingsResponse>();
    let persisted = discoveryResponse(50, 72);
    const updateDiscoverySettings = vi.fn()
      .mockImplementationOnce(() => pending.promise)
      .mockImplementationOnce(async () => {
        persisted = discoveryResponse(55, 48);
        return persisted;
      });
    const { queryClient } = renderWithProviders(<DiscoveryRuntimeSettingsPanel />, {
      ports: buildTestPorts({ api: { discoverySettings: vi.fn(async () => persisted), updateDiscoverySettings } }),
    });
    const results = await screen.findByLabelText("Results per board");
    await user.clear(results);
    await user.type(results, "25");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateDiscoverySettings).toHaveBeenCalledTimes(1));
    await user.clear(results);
    await user.type(results, "50");
    await act(async () => pending.reject(new Error("Synthetic save failed")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Synthetic save failed");
    expect(results).toHaveValue(50);
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await act(async () => { await queryClient.refetchQueries(); });
    expect(results).toHaveValue(50);

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateDiscoverySettings).toHaveBeenCalledTimes(2));
    expect(updateDiscoverySettings).toHaveBeenNthCalledWith(2, expect.objectContaining({ resultsPerSite: 50 }));
    await waitFor(() => expect(results).toHaveValue(55));
    expect(screen.getByLabelText("Posting lookback hours")).toHaveValue(48);
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    { next: 50, saved: 25, pending: true },
    { next: 30, saved: 30, pending: false },
  ])("reconciles a later value of $next against the saved value $saved", async ({ next, saved, pending: hasPending }) => {
    const user = userEvent.setup();
    const pending = deferred<DiscoverySettingsResponse>();
    let persisted = discoveryResponse(50, 72);
    const { queryClient } = renderWithProviders(<DiscoveryRuntimeSettingsPanel />, {
      ports: buildTestPorts({ api: {
        discoverySettings: vi.fn(async () => persisted),
        updateDiscoverySettings: vi.fn(() => pending.promise),
      } }),
    });
    const results = await screen.findByLabelText("Results per board");
    await user.clear(results);
    await user.type(results, "25");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("button", { name: "Saving changes" });
    await user.clear(results);
    await user.type(results, String(next));
    persisted = discoveryResponse(saved, 72);
    await act(async () => pending.resolve(persisted));
    await screen.findByText(/Runtime settings saved/);
    expect(results).toHaveValue(next);
    await act(async () => { await queryClient.refetchQueries(); });
    expect(results).toHaveValue(next);
    if (hasPending) {
      expect(screen.getByText(/newer changes pending/i)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Discard changes" }));
      expect(results).toHaveValue(saved);
    } else {
      expect(screen.queryByText(/newer changes pending/i)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    }
  });

  it("announces a schedule restart only after the edited schedule is saved", async () => {
    const user = userEvent.setup();
    const pending = deferred<DiscoverySettingsResponse>();
    let persisted = discoveryResponse(50, 72);
    const updateDiscoverySettings = vi.fn()
      .mockImplementationOnce(() => pending.promise)
      .mockImplementationOnce(async () => {
        persisted = discoveryResponse(25, 72, sampleDiscoverySettingsResponse.settings.boards, true);
        return persisted;
      });
    renderWithProviders(<DiscoveryRuntimeSettingsPanel />, {
      ports: buildTestPorts({ api: { discoverySettings: vi.fn(async () => persisted), updateDiscoverySettings } }),
    });
    const results = await screen.findByLabelText("Results per board");
    await user.clear(results);
    await user.type(results, "25");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateDiscoverySettings).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("checkbox", { name: "Enable scheduled discovery" }));
    persisted = discoveryResponse(25, 72);
    await act(async () => pending.resolve(persisted));
    expect(await screen.findByText(/newer changes pending/i)).not.toHaveTextContent(/Restart pending/);
    expect(screen.getByRole("checkbox", { name: "Enable scheduled discovery" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/Restart pending/)).toBeInTheDocument();
    expect(updateDiscoverySettings).toHaveBeenNthCalledWith(2, expect.objectContaining({ schedulingEnabled: true }));
  });

  it("compares restart status against canonical saves while the refresh is still pending", async () => {
    const user = userEvent.setup();
    const firstSave = deferred<DiscoverySettingsResponse>();
    const refresh = deferred<DiscoverySettingsResponse>();
    const discoverySettings = vi.fn()
      .mockResolvedValueOnce(discoveryResponse(50, 72))
      .mockImplementation(() => refresh.promise);
    const updateDiscoverySettings = vi.fn()
      .mockImplementationOnce(() => firstSave.promise)
      .mockResolvedValueOnce(discoveryResponse(30, 72, sampleDiscoverySettingsResponse.settings.boards, true));
    renderWithProviders(<DiscoveryRuntimeSettingsPanel />, {
      ports: buildTestPorts({ api: { discoverySettings, updateDiscoverySettings } }),
    });
    const results = await screen.findByLabelText("Results per board");
    await user.clear(results);
    await user.type(results, "25");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateDiscoverySettings).toHaveBeenCalledTimes(1));
    await user.clear(results);
    await user.type(results, "30");
    await act(async () => firstSave.resolve(discoveryResponse(25, 72, sampleDiscoverySettingsResponse.settings.boards, true)));
    expect(await screen.findByText(/newer changes pending/i)).toHaveTextContent(/Restart pending/);
    await waitFor(() => expect(discoverySettings).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Runtime settings saved.")).toBeInTheDocument();
    expect(updateDiscoverySettings).toHaveBeenNthCalledWith(2, expect.objectContaining({
      resultsPerSite: 30,
    }));
    expect(updateDiscoverySettings.mock.calls[1]?.[0]).not.toHaveProperty("schedulingEnabled");
    await act(async () => refresh.resolve(discoveryResponse(30, 72, sampleDiscoverySettingsResponse.settings.boards, true)));
  });

  it.each(["pending", "failed"])("discards to the acknowledged values when the post-save refresh is %s", async (refreshState) => {
    const user = userEvent.setup();
    const save = deferred<DiscoverySettingsResponse>();
    const refresh = deferred<DiscoverySettingsResponse>();
    const discoverySettings = vi.fn()
      .mockResolvedValueOnce(discoveryResponse(50, 72))
      .mockImplementation(() => refresh.promise);
    const { queryClient } = renderWithProviders(<DiscoveryRuntimeSettingsPanel />, {
      ports: buildTestPorts({ api: { discoverySettings, updateDiscoverySettings: vi.fn(() => save.promise) } }),
    });
    const results = await screen.findByLabelText("Results per board");
    const hours = screen.getByLabelText("Posting lookback hours");
    await user.clear(results);
    await user.type(results, "25");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("button", { name: "Saving changes" });
    await user.clear(results);
    await user.type(results, "30");
    const saved = discoveryResponse(26, 48);
    await act(async () => save.resolve(saved));
    await screen.findByText(/newer changes pending/i);
    await waitFor(() => expect(discoverySettings).toHaveBeenCalledTimes(2));
    if (refreshState === "failed") {
      await act(async () => refresh.reject(new Error("Synthetic refresh failed")));
      await waitFor(() => expect(queryClient.isFetching()).toBe(0));
      expect(results).toHaveValue(30);
      expect(await screen.findByRole("alert")).toHaveTextContent("Synthetic refresh failed");
    }
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(results).toHaveValue(26);
    expect(hours).toHaveValue(48);
    if (refreshState === "pending") await act(async () => refresh.resolve(saved));
  });

  it("discards a dirty draft to a newer completed cache refresh", async () => {
    const user = userEvent.setup();
    let persisted = discoveryResponse(50, 72);
    const { queryClient } = renderWithProviders(<DiscoveryRuntimeSettingsPanel />, {
      ports: buildTestPorts({ api: { discoverySettings: vi.fn(async () => persisted) } }),
    });
    const results = await screen.findByLabelText("Results per board");
    await user.clear(results);
    await user.type(results, "25");
    persisted = discoveryResponse(70, 36);
    await act(async () => { await queryClient.refetchQueries(); });
    expect(results).toHaveValue(25);
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(results).toHaveValue(70);
    expect(screen.getByLabelText("Posting lookback hours")).toHaveValue(36);
  });

  it.each(["before", "after"])("preserves a canonical save when the sibling automation save starts %s it", async (timing) => {
    const user = userEvent.setup();
    const runtimeSave = deferred<DiscoverySettingsResponse>();
    const automationSave = deferred<DiscoverySettingsResponse>();
    const refresh = deferred<DiscoverySettingsResponse>();
    const initial = discoveryResponse(50, 72);
    const discoverySettings = vi.fn().mockResolvedValueOnce(initial).mockImplementation(() => refresh.promise);
    const updateDiscoverySettings = vi.fn()
      .mockImplementationOnce(() => runtimeSave.promise)
      .mockImplementationOnce(() => automationSave.promise);
    const panels = <><DiscoveryAutomationSettingsPanel /><DiscoveryRuntimeSettingsPanel /></>;
    const { container, queryClient, rerender } = renderWithProviders(panels, {
      ports: buildTestPorts({ api: { discoverySettings, updateDiscoverySettings } }),
    });
    const runtime = container.querySelector(".discovery-runtime-settings") as HTMLElement;
    const automation = container.querySelector(".discovery-automation-settings") as HTMLElement;
    const cron = await within(runtime).findByLabelText("Schedule cron");
    const results = within(runtime).getByLabelText("Results per board");
    await user.clear(cron);
    await user.type(cron, " 0 7 * * * ");
    await user.click(within(runtime).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateDiscoverySettings).toHaveBeenCalledTimes(1));
    await user.clear(results);
    await user.type(results, "30");

    async function startAutomationSave() {
      await user.click(within(automation).getByRole("checkbox", { name: "Auto apply" }));
      await user.click(within(automation).getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(updateDiscoverySettings).toHaveBeenCalledTimes(2));
    }
    if (timing === "before") await startAutomationSave();
    await act(async () => runtimeSave.resolve(initial));
    await within(runtime).findByText(/newer changes pending/i);
    await waitFor(() => expect(discoverySettings.mock.calls.length).toBeGreaterThan(1));
    if (timing === "after") await startAutomationSave();

    const cached = queryClient.getQueryData<DiscoverySettingsResponse>(discoveryKeys.settings(LOCAL_TENANT));
    expect(cached?.settings.autoApply).toBe(true);
    await user.click(within(runtime).getByRole("button", { name: "Discard changes" }));
    expect(cron).toHaveValue("0 7 * * *");
    const savedAutomation = {
      ...initial,
      settings: { ...initial.settings, autoApply: true },
      effectiveSettings: { ...initial.effectiveSettings, autoApply: { ...initial.effectiveSettings.autoApply, value: true } },
    };
    await act(async () => automationSave.resolve(savedAutomation));
    await within(automation).findByText("Automation settings saved in SQLite");
    rerender(<DiscoveryAutomationSettingsPanel />);
    rerender(panels);
    expect(await screen.findByLabelText("Schedule cron")).toHaveValue("0 7 * * *");
    await act(async () => refresh.resolve(initial));
    expect(screen.getByLabelText("Schedule cron")).toHaveValue("0 7 * * *");
  });

  it("retains a canonical runtime acknowledgement after an overlapping sibling mutation rolls back", async () => {
    const user = userEvent.setup();
    const runtimeSave = deferred<DiscoverySettingsResponse>();
    const automationSave = deferred<DiscoverySettingsResponse>();
    const refresh = deferred<DiscoverySettingsResponse>();
    const initial = discoveryResponse(50, 72);
    const discoverySettings = vi.fn().mockResolvedValueOnce(initial).mockImplementation(() => refresh.promise);
    const updateDiscoverySettings = vi.fn()
      .mockImplementationOnce(() => runtimeSave.promise)
      .mockImplementationOnce(() => automationSave.promise);
    const panels = <><AutomationSaveControl /><DiscoveryRuntimeSettingsPanel /></>;
    const { rerender } = renderWithProviders(panels, {
      ports: buildTestPorts({ api: { discoverySettings, updateDiscoverySettings } }),
    });
    const cron = await screen.findByLabelText("Schedule cron");
    await user.clear(cron);
    await user.type(cron, " 0 7 * * * ");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateDiscoverySettings).toHaveBeenCalledTimes(1));
    const results = screen.getByLabelText("Results per board");
    await user.clear(results);
    await user.type(results, "30");
    await user.click(screen.getByRole("button", { name: "Save sibling automation" }));
    await waitFor(() => expect(updateDiscoverySettings).toHaveBeenCalledTimes(2));
    await act(async () => runtimeSave.resolve(initial));
    await screen.findByText(/newer changes pending/i);
    await act(async () => automationSave.reject(new Error("Synthetic automation failure")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Synthetic automation failure");
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(cron).toHaveValue("0 7 * * *");
    rerender(<AutomationSaveControl />);
    rerender(panels);
    expect(await screen.findByLabelText("Schedule cron")).toHaveValue("0 7 * * *");
    await act(async () => refresh.resolve(initial));
  });

  it("retains the acknowledged response across remount and failed refresh, then adopts a successful read", async () => {
    const user = userEvent.setup();
    const save = deferred<DiscoverySettingsResponse>();
    const refresh = deferred<DiscoverySettingsResponse>();
    const canonical = discoveryResponse(50, 72);
    const discoverySettings = vi.fn()
      .mockResolvedValueOnce(canonical)
      .mockImplementationOnce(() => refresh.promise)
      .mockResolvedValue(discoveryResponse(60, 48));
    const { rerender, queryClient } = renderWithProviders(<DiscoveryRuntimeSettingsPanel />, {
      ports: buildTestPorts({ api: { discoverySettings, updateDiscoverySettings: vi.fn(() => save.promise) } }),
    });
    const cron = await screen.findByLabelText("Schedule cron");
    await user.clear(cron);
    await user.type(cron, " 0 7 * * * ");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("button", { name: "Saving changes" });
    await act(async () => save.resolve(canonical));
    await screen.findByText("Runtime settings saved.");
    await waitFor(() => expect(discoverySettings).toHaveBeenCalledTimes(2));
    rerender(<></>);
    rerender(<DiscoveryRuntimeSettingsPanel />);
    expect(await screen.findByLabelText("Schedule cron")).toHaveValue("0 7 * * *");
    await act(async () => refresh.reject(new Error("Synthetic refresh failure")));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Schedule cron")).toHaveValue("0 7 * * *");
    await act(async () => { await queryClient.refetchQueries(); });
    await waitFor(() => expect(screen.getByLabelText("Results per board")).toHaveValue(60));
    expect(screen.getByLabelText("Posting lookback hours")).toHaveValue(48);
  });

  it("orders actual writes across remount and keeps later typing pending", async () => {
    const user = userEvent.setup();
    const first = deferred<void>();
    const second = deferred<void>();
    let persisted = discoveryResponse(50, 72);
    const discoverySettings = vi.fn(async () => persisted);
    const commit = (body: DiscoverySettingsUpdateRequest) => {
      persisted = discoveryPatch(persisted, body);
      return persisted;
    };
    const updateDiscoverySettings = vi.fn()
      .mockImplementationOnce(async (body: DiscoverySettingsUpdateRequest) => { await first.promise; return commit(body); })
      .mockImplementationOnce(async (body: DiscoverySettingsUpdateRequest) => { await second.promise; return commit(body); })
      .mockImplementation(async (body: DiscoverySettingsUpdateRequest) => commit(body));
    const { rerender } = renderWithProviders(<DiscoveryRuntimeSettingsPanel />, {
      ports: buildTestPorts({ api: { discoverySettings, updateDiscoverySettings } }),
    });
    const results = await screen.findByLabelText("Results per board");
    await user.clear(results);
    await user.type(results, "25");
    const hours = screen.getByLabelText("Posting lookback hours");
    await user.clear(hours);
    await user.type(hours, "48");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateDiscoverySettings).toHaveBeenCalledTimes(1));
    rerender(<></>);
    rerender(<DiscoveryRuntimeSettingsPanel />);
    const newerResults = await screen.findByLabelText("Results per board");
    await user.clear(newerResults);
    await user.type(newerResults, "30");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("button", { name: "Saving changes" });
    await user.clear(newerResults);
    await user.type(newerResults, "35");
    const newerHours = screen.getByLabelText("Posting lookback hours");
    await user.clear(newerHours);
    await user.type(newerHours, "96");
    expect(updateDiscoverySettings).toHaveBeenCalledTimes(1);
    await act(async () => second.resolve());
    expect(persisted.settings.resultsPerSite).toBe(50);
    await act(async () => first.resolve());
    await waitFor(() => expect(updateDiscoverySettings).toHaveBeenCalledTimes(2));
    await screen.findByText(/newer changes pending/i);
    expect(updateDiscoverySettings).toHaveBeenNthCalledWith(2, { resultsPerSite: 30 });
    expect(persisted.settings.resultsPerSite).toBe(30);
    expect(persisted.settings.hoursOld).toBe(48);
    expect(newerResults).toHaveValue(35);
    expect(newerHours).toHaveValue(96);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateDiscoverySettings).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(persisted.settings.resultsPerSite).toBe(35));
    expect(persisted.settings.hoursOld).toBe(96);
  });

  it("releases the write queue after failures and retains the later draft for retry", async () => {
    const user = userEvent.setup();
    const first = deferred<DiscoverySettingsResponse>();
    const second = deferred<DiscoverySettingsResponse>();
    let persisted = discoveryResponse(50, 72);
    const updateDiscoverySettings = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockImplementation(async (body: DiscoverySettingsUpdateRequest) => {
        persisted = discoveryPatch(persisted, body);
        return persisted;
      });
    const { rerender } = renderWithProviders(<DiscoveryRuntimeSettingsPanel />, {
      ports: buildTestPorts({ api: { discoverySettings: vi.fn(async () => persisted), updateDiscoverySettings } }),
    });
    const results = await screen.findByLabelText("Results per board");
    await user.clear(results);
    await user.type(results, "25");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateDiscoverySettings).toHaveBeenCalledTimes(1));
    rerender(<></>);
    rerender(<DiscoveryRuntimeSettingsPanel />);
    const later = await screen.findByLabelText("Results per board");
    await user.clear(later);
    await user.type(later, "30");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("button", { name: "Saving changes" });
    expect(updateDiscoverySettings).toHaveBeenCalledTimes(1);
    await act(async () => first.reject(new Error("Synthetic first failure")));
    await waitFor(() => expect(updateDiscoverySettings).toHaveBeenCalledTimes(2));
    await act(async () => second.reject(new Error("Synthetic second failure")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Synthetic second failure");
    expect(later).toHaveValue(30);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateDiscoverySettings).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(persisted.settings.resultsPerSite).toBe(30));
  });

  it("preserves a deliberate edit back to the old value in a queued save", async () => {
    const user = userEvent.setup();
    const first = deferred<DiscoverySettingsResponse>();
    let persisted = discoveryResponse(50, 72);
    const updateDiscoverySettings = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async (body: DiscoverySettingsUpdateRequest) => {
        persisted = discoveryPatch(persisted, body);
        return persisted;
      });
    const { rerender } = renderWithProviders(<DiscoveryRuntimeSettingsPanel />, {
      ports: buildTestPorts({ api: { discoverySettings: vi.fn(async () => persisted), updateDiscoverySettings } }),
    });
    const results = await screen.findByLabelText("Results per board");
    await user.clear(results);
    await user.type(results, "25");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateDiscoverySettings).toHaveBeenCalledTimes(1));
    rerender(<></>);
    rerender(<DiscoveryRuntimeSettingsPanel />);
    const later = await screen.findByLabelText("Results per board");
    await user.clear(later);
    await user.type(later, "30");
    await user.clear(later);
    await user.type(later, "50");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("button", { name: "Saving changes" });
    expect(updateDiscoverySettings).toHaveBeenCalledTimes(1);
    persisted = discoveryResponse(25, 72);
    await act(async () => first.resolve(persisted));
    await waitFor(() => expect(updateDiscoverySettings).toHaveBeenCalledTimes(2));
    expect(updateDiscoverySettings).toHaveBeenNthCalledWith(2, expect.objectContaining({ resultsPerSite: 50 }));
    await waitFor(() => expect(persisted.settings.resultsPerSite).toBe(50));
  });

  it("does not overwrite a committed field after its acknowledgement is lost", async () => {
    const user = userEvent.setup();
    const first = deferred<void>();
    const refresh = deferred<DiscoverySettingsResponse>();
    let persisted = discoveryResponse(50, 72);
    const discoverySettings = vi.fn().mockResolvedValueOnce(persisted).mockImplementation(() => refresh.promise);
    const updateDiscoverySettings = vi.fn()
      .mockImplementationOnce(async (body: DiscoverySettingsUpdateRequest) => {
        await first.promise;
        persisted = discoveryResponse(body.resultsPerSite ?? persisted.settings.resultsPerSite, body.hoursOld ?? persisted.settings.hoursOld);
        throw new Error("Synthetic lost acknowledgement");
      })
      .mockImplementationOnce(async (body: DiscoverySettingsUpdateRequest) => {
        persisted = discoveryResponse(body.resultsPerSite ?? persisted.settings.resultsPerSite, body.hoursOld ?? persisted.settings.hoursOld);
        return persisted;
      });
    const { rerender } = renderWithProviders(<DiscoveryRuntimeSettingsPanel />, {
      ports: buildTestPorts({ api: { discoverySettings, updateDiscoverySettings } }),
    });
    const hours = await screen.findByLabelText("Posting lookback hours");
    await user.clear(hours);
    await user.type(hours, "48");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateDiscoverySettings).toHaveBeenCalledTimes(1));
    rerender(<></>);
    rerender(<DiscoveryRuntimeSettingsPanel />);
    const results = await screen.findByLabelText("Results per board");
    await user.clear(results);
    await user.type(results, "30");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("button", { name: "Saving changes" });
    expect(updateDiscoverySettings).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve());
    await waitFor(() => expect(updateDiscoverySettings).toHaveBeenCalledTimes(2));
    expect(updateDiscoverySettings).toHaveBeenNthCalledWith(2, { resultsPerSite: 30 });
    await waitFor(() => expect(persisted.settings.resultsPerSite).toBe(30));
    expect(persisted.settings.hoursOld).toBe(48);
    expect(screen.getByLabelText("Posting lookback hours")).toHaveValue(48);
    await act(async () => refresh.resolve(persisted));
  });

  it("retains prior board and schedule changes in a queued runtime save", async () => {
    const user = userEvent.setup();
    const first = deferred<DiscoverySettingsResponse>();
    let persisted = discoveryResponse(50, 72);
    const boards = [...persisted.settings.boards, "glassdoor" as const];
    const updateDiscoverySettings = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async (body: DiscoverySettingsUpdateRequest) => {
        persisted = discoveryPatch(persisted, body);
        return persisted;
      });
    const { rerender } = renderWithProviders(<DiscoveryRuntimeSettingsPanel />, {
      ports: buildTestPorts({ api: { discoverySettings: vi.fn(async () => persisted), updateDiscoverySettings } }),
    });
    await user.click(await screen.findByRole("checkbox", { name: "Glassdoor" }));
    await user.click(screen.getByRole("checkbox", { name: "Enable scheduled discovery" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateDiscoverySettings).toHaveBeenCalledTimes(1));
    rerender(<></>);
    rerender(<DiscoveryRuntimeSettingsPanel />);
    const results = await screen.findByLabelText("Results per board");
    await user.clear(results);
    await user.type(results, "30");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("button", { name: "Saving changes" });
    expect(updateDiscoverySettings).toHaveBeenCalledTimes(1);
    persisted = discoveryResponse(50, 72, boards, true);
    await act(async () => first.resolve(persisted));
    await waitFor(() => expect(updateDiscoverySettings).toHaveBeenCalledTimes(2));
    expect(updateDiscoverySettings).toHaveBeenNthCalledWith(2, { resultsPerSite: 30 });
    expect(await screen.findByText("Runtime settings saved.")).not.toHaveTextContent(/Restart pending/);
    expect(persisted.settings.boards).toEqual(boards);
    expect(persisted.settings.schedulingEnabled).toBe(true);
  });

  it("keeps the accepted baseline through tenant-wide invalidation failures and later refreshes", async () => {
    const user = userEvent.setup();
    const save = deferred<DiscoverySettingsResponse>();
    const postSaveRead = deferred<DiscoverySettingsResponse>();
    const reconnectRead = deferred<DiscoverySettingsResponse>();
    const canonical = discoveryResponse(26, 72);
    const discoverySettings = vi.fn()
      .mockResolvedValueOnce(discoveryResponse(50, 72))
      .mockImplementationOnce(() => postSaveRead.promise)
      .mockImplementationOnce(() => reconnectRead.promise)
      .mockResolvedValue(discoveryResponse(40, 48));
    const { queryClient } = renderWithProviders(<DiscoveryRuntimeSettingsPanel />, {
      ports: buildTestPorts({ api: { discoverySettings, updateDiscoverySettings: vi.fn(() => save.promise) } }),
    });
    const results = await screen.findByLabelText("Results per board");
    await user.clear(results);
    await user.type(results, "25");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("button", { name: "Saving changes" });
    await user.clear(results);
    await user.type(results, "30");
    await act(async () => save.resolve(canonical));
    await screen.findByText(/newer changes pending/i);
    await waitFor(() => expect(discoverySettings).toHaveBeenCalledTimes(2));

    let invalidation!: Promise<void>;
    await act(async () => { invalidation = queryClient.invalidateQueries({ queryKey: ["tenant", LOCAL_TENANT] }); });
    await waitFor(() => expect(discoverySettings).toHaveBeenCalledTimes(3));
    await act(async () => { reconnectRead.reject(new Error("Synthetic reconnect failure")); await invalidation; });
    expect(results).toHaveValue(30);
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(results).toHaveValue(26);
    await user.clear(results);
    await user.type(results, "35");
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["tenant", LOCAL_TENANT] }); });
    expect(results).toHaveValue(35);
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(results).toHaveValue(40);
    expect(screen.getByLabelText("Posting lookback hours")).toHaveValue(48);
    await act(async () => postSaveRead.resolve(canonical));
  });
});
