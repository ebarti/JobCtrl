import type { SettingsResponse, SettingsUpdateRequest } from "@jobctrl/contracts";
import { LOCAL_TENANT, type TenantId } from "@jobctrl/domain-types";
import { act, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { sampleSettingsResponse } from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { settingsKeys } from "../../operations/settingsKeys.js";
import { ScoringGuidancePanel } from "../../scoring/components/ScoringGuidancePanel.js";
import { ApplyRuntimeSettingsPanel } from "./ApplyRuntimeSettingsPanel.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function applyResponse(timeout: number, budget: number): SettingsResponse {
  return {
    ...sampleSettingsResponse,
    settings: { ...sampleSettingsResponse.settings, applyTimeoutSeconds: timeout, applyMaxBudgetUsd: budget },
    effectiveSettings: {
      ...sampleSettingsResponse.effectiveSettings,
      applyTimeoutSeconds: { ...sampleSettingsResponse.effectiveSettings.applyTimeoutSeconds, value: timeout },
      applyMaxBudgetUsd: { ...sampleSettingsResponse.effectiveSettings.applyMaxBudgetUsd, value: budget },
    },
  };
}

function applyPatch(current: SettingsResponse, body: SettingsUpdateRequest): SettingsResponse {
  return applyResponse(
    body.applyTimeoutSeconds ?? current.settings.applyTimeoutSeconds,
    body.applyMaxBudgetUsd ?? current.settings.applyMaxBudgetUsd,
  );
}

describe("<ApplyRuntimeSettingsPanel>", () => {
  it("does not expose the internal apply context as card metadata", async () => {
    renderWithProviders(<ApplyRuntimeSettingsPanel />);
    expect(
      screen.queryByText("apply", { selector: ".meta" }),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByLabelText("Maximum AI budget per application (USD)"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("apply", { selector: ".meta" }),
    ).not.toBeInTheDocument();
  });

  it("distinguishes the zero-dollar cap and agent timeout", async () => {
    renderWithProviders(<ApplyRuntimeSettingsPanel />);
    expect(
      await screen.findByLabelText("Maximum AI budget per application (USD)"),
    ).toHaveValue(5);
    expect(
      screen.getByText(/zero-dollar cap, not unlimited/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/separate from Temporal activity timeouts/i),
    ).toBeInTheDocument();
  });

  it("links every application runtime setting to its owning documentation", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ApplyRuntimeSettingsPanel />);

    await screen.findByLabelText("Maximum AI budget per application (USD)");
    expect(
      screen.getByRole("button", {
        name: "Help for Maximum AI budget per application",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Help for Apply agent timeout" }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Help for Apply agent timeout" }),
    );
    expect(screen.getByRole("link", { name: "Open documentation" })).toHaveAttribute(
      "href",
      "https://jobctrl.dev/user/apply#runtime-setting-apply-agent-timeout",
    );
  });

  it("uses shared field, input, and action primitives", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ApplyRuntimeSettingsPanel />);

    await screen.findByLabelText("Maximum AI budget per application (USD)");
    expect(container.querySelectorAll('[data-slot="field"]')).toHaveLength(2);
    expect(container.querySelectorAll('input[data-slot="input"]')).toHaveLength(
      2,
    );
    const save = screen.getByRole("button", {
      name: "Save application runtime",
    });
    const discard = screen.getByRole("button", { name: "Discard changes" });
    expect(save).toHaveAttribute("data-slot", "button");
    expect(save).toBeDisabled();
    expect(discard).toBeDisabled();
    await user.clear(screen.getByLabelText("Apply agent timeout (seconds)"));
    await user.type(
      screen.getByLabelText("Apply agent timeout (seconds)"),
      "1200",
    );
    expect(save).toBeEnabled();
    expect(discard).toBeEnabled();
    expect(container.querySelector(".settings-save-actions")).toHaveAttribute(
      "data-save-state",
      "dirty",
    );
  });

  it("rebases newer edits over the saved response and submits them on the next save", async () => {
    const user = userEvent.setup();
    const pending = deferred<SettingsResponse>();
    let persisted = applyResponse(900, 5);
    const updateSettings = vi.fn()
      .mockImplementationOnce(() => pending.promise)
      .mockImplementationOnce(async (body: SettingsUpdateRequest) => {
        persisted = applyPatch(persisted, body);
        return persisted;
      });
    const { container, queryClient } = renderWithProviders(<ApplyRuntimeSettingsPanel />, {
      ports: buildTestPorts({ api: { settings: vi.fn(async () => persisted), updateSettings } }),
    });
    const timeout = await screen.findByLabelText("Apply agent timeout (seconds)");
    const budget = screen.getByLabelText("Maximum AI budget per application (USD)");
    await user.clear(timeout);
    await user.type(timeout, "1200");
    await user.clear(budget);
    await user.type(budget, "6");
    await user.click(screen.getByRole("button", { name: "Save application runtime" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings).toHaveBeenNthCalledWith(1, { applyTimeoutSeconds: 1200, applyMaxBudgetUsd: 6 });

    await user.clear(timeout);
    await user.type(timeout, "1500");
    await act(async () => { await queryClient.refetchQueries(); });
    expect(timeout).toHaveValue(1500);
    persisted = applyResponse(1200, 6.5);
    await act(async () => pending.resolve(persisted));

    await waitFor(() => expect(container.querySelector(".settings-save-actions")).not.toHaveAttribute("data-save-state", "saving"));
    expect(timeout).toHaveValue(1500);
    expect(budget).toHaveValue(6.5);
    expect(container.querySelector(".settings-save-actions")).toHaveAttribute("data-save-state", "dirty");
    expect(screen.getByText("Saved; newer changes pending.")).toBeInTheDocument();
    await act(async () => { await queryClient.refetchQueries(); });
    expect(timeout).toHaveValue(1500);
    expect(budget).toHaveValue(6.5);

    await user.click(screen.getByRole("button", { name: "Save application runtime" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(2));
    expect(updateSettings).toHaveBeenNthCalledWith(2, { applyTimeoutSeconds: 1500 });
    await waitFor(() => expect(container.querySelector(".settings-save-actions")).toHaveAttribute("data-save-state", "saved"));
    await user.clear(timeout);
    await user.type(timeout, "1600");
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(timeout).toHaveValue(1500);
  });

  it("retains edits after a failed pending save and adopts a later canonical response", async () => {
    const user = userEvent.setup();
    const pending = deferred<SettingsResponse>();
    let persisted = applyResponse(900, 5);
    const updateSettings = vi.fn()
      .mockImplementationOnce(() => pending.promise)
      .mockImplementationOnce(async () => {
        persisted = applyResponse(910, 5.5);
        return persisted;
      });
    const { container, queryClient } = renderWithProviders(<ApplyRuntimeSettingsPanel />, {
      ports: buildTestPorts({ api: { settings: vi.fn(async () => persisted), updateSettings } }),
    });
    const timeout = await screen.findByLabelText("Apply agent timeout (seconds)");
    await user.clear(timeout);
    await user.type(timeout, "1200");
    await user.click(screen.getByRole("button", { name: "Save application runtime" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    await user.clear(timeout);
    await user.type(timeout, "900");
    await act(async () => pending.reject(new Error("Synthetic save failed")));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be saved");
    expect(timeout).toHaveValue(900);
    expect(container.querySelector(".settings-save-actions")).toHaveAttribute("data-save-state", "dirty");
    await act(async () => { await queryClient.refetchQueries(); });
    expect(timeout).toHaveValue(900);

    await user.click(screen.getByRole("button", { name: "Save application runtime" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(2));
    expect(updateSettings).toHaveBeenNthCalledWith(2, { applyTimeoutSeconds: 900 });
    await waitFor(() => expect(timeout).toHaveValue(910));
    expect(screen.getByLabelText("Maximum AI budget per application (USD)")).toHaveValue(5.5);
    expect(container.querySelector(".settings-save-actions")).toHaveAttribute("data-save-state", "saved");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    { next: 900, saved: 1200, pending: true },
    { next: 1500, saved: 1500, pending: false },
  ])("reconciles a later value of $next against the saved value $saved", async ({ next, saved, pending: hasPending }) => {
    const user = userEvent.setup();
    const pending = deferred<SettingsResponse>();
    let persisted = applyResponse(900, 5);
    const { container, queryClient } = renderWithProviders(<ApplyRuntimeSettingsPanel />, {
      ports: buildTestPorts({ api: {
        settings: vi.fn(async () => persisted),
        updateSettings: vi.fn(() => pending.promise),
      } }),
    });
    const timeout = await screen.findByLabelText("Apply agent timeout (seconds)");
    await user.clear(timeout);
    await user.type(timeout, "1200");
    await user.click(screen.getByRole("button", { name: "Save application runtime" }));
    await screen.findByRole("button", { name: "Saving application runtime" });
    await user.clear(timeout);
    await user.type(timeout, String(next));
    persisted = applyResponse(saved, 5);
    await act(async () => pending.resolve(persisted));
    await waitFor(() => expect(container.querySelector(".settings-save-actions")).toHaveAttribute(
      "data-save-state", hasPending ? "dirty" : "saved",
    ));
    expect(timeout).toHaveValue(next);
    await act(async () => { await queryClient.refetchQueries(); });
    expect(timeout).toHaveValue(next);
    if (hasPending) {
      expect(screen.getByText("Saved; newer changes pending.")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Discard changes" }));
      expect(timeout).toHaveValue(saved);
    } else {
      expect(screen.queryByText("Saved; newer changes pending.")).not.toBeInTheDocument();
    }
  });

  it.each(["pending", "failed"])("discards to the acknowledged values when the post-save refresh is %s", async (refreshState) => {
    const user = userEvent.setup();
    const save = deferred<SettingsResponse>();
    const refresh = deferred<SettingsResponse>();
    const settings = vi.fn()
      .mockResolvedValueOnce(applyResponse(900, 5))
      .mockImplementation(() => refresh.promise);
    const { queryClient } = renderWithProviders(<ApplyRuntimeSettingsPanel />, {
      ports: buildTestPorts({ api: { settings, updateSettings: vi.fn(() => save.promise) } }),
    });
    const timeout = await screen.findByLabelText("Apply agent timeout (seconds)");
    const budget = screen.getByLabelText("Maximum AI budget per application (USD)");
    await user.clear(timeout);
    await user.type(timeout, "1200");
    await user.click(screen.getByRole("button", { name: "Save application runtime" }));
    await screen.findByRole("button", { name: "Saving application runtime" });
    await user.clear(timeout);
    await user.type(timeout, "1500");
    const saved = applyResponse(1201, 5.5);
    await act(async () => save.resolve(saved));
    await screen.findByText("Saved; newer changes pending.");
    await waitFor(() => expect(settings).toHaveBeenCalledTimes(2));
    if (refreshState === "failed") {
      await act(async () => refresh.reject(new Error("Synthetic refresh failed")));
      await waitFor(() => expect(queryClient.isFetching()).toBe(0));
      expect(timeout).toHaveValue(1500);
    }
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(timeout).toHaveValue(1201);
    expect(budget).toHaveValue(5.5);
    if (refreshState === "pending") await act(async () => refresh.resolve(saved));
  });

  it("discards a dirty draft to a newer completed cache refresh", async () => {
    const user = userEvent.setup();
    let persisted = applyResponse(900, 5);
    const { queryClient } = renderWithProviders(<ApplyRuntimeSettingsPanel />, {
      ports: buildTestPorts({ api: { settings: vi.fn(async () => persisted) } }),
    });
    const timeout = await screen.findByLabelText("Apply agent timeout (seconds)");
    await user.clear(timeout);
    await user.type(timeout, "1200");
    persisted = applyResponse(1000, 7);
    await act(async () => { await queryClient.refetchQueries(); });
    expect(timeout).toHaveValue(1200);
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(timeout).toHaveValue(1000);
    expect(screen.getByLabelText("Maximum AI budget per application (USD)")).toHaveValue(7);
  });

  it.each(["before", "after"])("preserves a canonical save when the sibling guidance save starts %s it", async (timing) => {
    const user = userEvent.setup();
    const runtimeSave = deferred<SettingsResponse>();
    const guidanceSave = deferred<SettingsResponse>();
    const refresh = deferred<SettingsResponse>();
    const initial = applyResponse(900, 5);
    const canonical = applyResponse(1201, 5.5);
    const settings = vi.fn().mockResolvedValueOnce(initial).mockImplementation(() => refresh.promise);
    const updateSettings = vi.fn()
      .mockImplementationOnce(() => runtimeSave.promise)
      .mockImplementationOnce(() => guidanceSave.promise);
    const panels = <><ApplyRuntimeSettingsPanel /><ScoringGuidancePanel /></>;
    const { container, queryClient, rerender } = renderWithProviders(panels, {
      ports: buildTestPorts({ api: { settings, updateSettings } }),
    });
    const runtime = container.querySelector(".application-runtime-settings") as HTMLElement;
    const guidance = container.querySelector(".scoring-guidance-settings") as HTMLElement;
    const timeout = await within(runtime).findByLabelText("Apply agent timeout (seconds)");
    await user.clear(timeout);
    await user.type(timeout, "1200");
    await user.click(within(runtime).getByRole("button", { name: "Save application runtime" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    await user.clear(timeout);
    await user.type(timeout, "1500");

    async function startGuidanceSave() {
      await user.click(guidance.querySelector(".configuration-section__trigger") as HTMLElement);
      const scoreCriteria = within(guidance).getByLabelText("Scoring priorities");
      await user.clear(scoreCriteria);
      await user.type(scoreCriteria, "Synthetic priority");
      await user.click(within(guidance).getByRole("button", { name: "Save scoring guidance" }));
      await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(2));
    }
    if (timing === "before") await startGuidanceSave();
    await act(async () => runtimeSave.resolve(canonical));
    await within(runtime).findByText("Saved; newer changes pending.");
    await waitFor(() => expect(settings.mock.calls.length).toBeGreaterThan(1));
    if (timing === "after") await startGuidanceSave();

    const cached = queryClient.getQueryData<SettingsResponse>(settingsKeys.settings(LOCAL_TENANT));
    expect(cached?.settings.scoreCriteria).toBe("Synthetic priority");
    await user.click(within(runtime).getByRole("button", { name: "Discard changes" }));
    expect(timeout).toHaveValue(1201);
    await act(async () => guidanceSave.reject(new Error("Synthetic guidance failure")));
    await waitFor(() => expect(within(guidance).getByRole("alert")).toHaveTextContent("could not be saved"));
    rerender(<ScoringGuidancePanel />);
    rerender(panels);
    expect(await screen.findByLabelText("Apply agent timeout (seconds)")).toHaveValue(1201);
    await act(async () => refresh.resolve(canonical));
    expect(screen.getByLabelText("Apply agent timeout (seconds)")).toHaveValue(1201);
  });

  it("retains the acknowledged response across remount and failed refresh, then adopts a successful read", async () => {
    const user = userEvent.setup();
    const save = deferred<SettingsResponse>();
    const refresh = deferred<SettingsResponse>();
    const canonical = applyResponse(1201, 5.5);
    const settings = vi.fn()
      .mockResolvedValueOnce(applyResponse(900, 5))
      .mockImplementationOnce(() => refresh.promise)
      .mockResolvedValue(applyResponse(1300, 6));
    const { rerender, queryClient } = renderWithProviders(<ApplyRuntimeSettingsPanel />, {
      ports: buildTestPorts({ api: { settings, updateSettings: vi.fn(() => save.promise) } }),
    });
    const timeout = await screen.findByLabelText("Apply agent timeout (seconds)");
    await user.clear(timeout);
    await user.type(timeout, "1200");
    await user.click(screen.getByRole("button", { name: "Save application runtime" }));
    await screen.findByRole("button", { name: "Saving application runtime" });
    await act(async () => save.resolve(canonical));
    await screen.findByText("Application runtime saved for newly started application jobs.");
    await waitFor(() => expect(settings).toHaveBeenCalledTimes(2));
    rerender(<></>);
    rerender(<ApplyRuntimeSettingsPanel />);
    expect(await screen.findByLabelText("Apply agent timeout (seconds)")).toHaveValue(1201);
    await act(async () => refresh.reject(new Error("Synthetic refresh failure")));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(screen.getByLabelText("Apply agent timeout (seconds)")).toHaveValue(1201);
    await act(async () => { await queryClient.refetchQueries(); });
    await waitFor(() => expect(screen.getByLabelText("Apply agent timeout (seconds)")).toHaveValue(1300));
    expect(screen.getByLabelText("Maximum AI budget per application (USD)")).toHaveValue(6);
  });

  it("orders actual writes across remount and keeps later typing pending", async () => {
    const user = userEvent.setup();
    const first = deferred<void>();
    const second = deferred<void>();
    let persisted = applyResponse(900, 5);
    const settings = vi.fn(async () => persisted);
    const commit = (body: SettingsUpdateRequest) => {
      persisted = applyPatch(persisted, body);
      return persisted;
    };
    const updateSettings = vi.fn()
      .mockImplementationOnce(async (body: SettingsUpdateRequest) => { await first.promise; return commit(body); })
      .mockImplementationOnce(async (body: SettingsUpdateRequest) => { await second.promise; return commit(body); })
      .mockImplementation(async (body: SettingsUpdateRequest) => commit(body));
    const { rerender } = renderWithProviders(<ApplyRuntimeSettingsPanel />, {
      ports: buildTestPorts({ api: { settings, updateSettings } }),
    });
    const timeout = await screen.findByLabelText("Apply agent timeout (seconds)");
    await user.clear(timeout);
    await user.type(timeout, "1200");
    const budget = screen.getByLabelText("Maximum AI budget per application (USD)");
    await user.clear(budget);
    await user.type(budget, "6");
    await user.click(screen.getByRole("button", { name: "Save application runtime" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    rerender(<></>);
    rerender(<ApplyRuntimeSettingsPanel />);
    const newerTimeout = await screen.findByLabelText("Apply agent timeout (seconds)");
    await user.clear(newerTimeout);
    await user.type(newerTimeout, "1500");
    await user.click(screen.getByRole("button", { name: "Save application runtime" }));
    await screen.findByRole("button", { name: "Saving application runtime" });
    await user.clear(newerTimeout);
    await user.type(newerTimeout, "1600");
    const newerBudget = screen.getByLabelText("Maximum AI budget per application (USD)");
    await user.clear(newerBudget);
    await user.type(newerBudget, "8");
    expect(updateSettings).toHaveBeenCalledTimes(1);
    await act(async () => second.resolve());
    expect(persisted.settings.applyTimeoutSeconds).toBe(900);
    await act(async () => first.resolve());
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(2));
    await screen.findByText("Saved; newer changes pending.");
    expect(updateSettings).toHaveBeenNthCalledWith(2, { applyTimeoutSeconds: 1500 });
    expect(persisted.settings.applyTimeoutSeconds).toBe(1500);
    expect(persisted.settings.applyMaxBudgetUsd).toBe(6);
    expect(newerTimeout).toHaveValue(1600);
    expect(newerBudget).toHaveValue(8);
    await user.click(screen.getByRole("button", { name: "Save application runtime" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(persisted.settings.applyTimeoutSeconds).toBe(1600));
    expect(persisted.settings.applyMaxBudgetUsd).toBe(8);
  });

  it("releases the write queue after failures and retains the later draft for retry", async () => {
    const user = userEvent.setup();
    const first = deferred<SettingsResponse>();
    const second = deferred<SettingsResponse>();
    let persisted = applyResponse(900, 5);
    const updateSettings = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockImplementation(async (body: SettingsUpdateRequest) => {
        persisted = applyPatch(persisted, body);
        return persisted;
      });
    const { rerender } = renderWithProviders(<ApplyRuntimeSettingsPanel />, {
      ports: buildTestPorts({ api: { settings: vi.fn(async () => persisted), updateSettings } }),
    });
    const timeout = await screen.findByLabelText("Apply agent timeout (seconds)");
    await user.clear(timeout);
    await user.type(timeout, "1200");
    await user.click(screen.getByRole("button", { name: "Save application runtime" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    rerender(<></>);
    rerender(<ApplyRuntimeSettingsPanel />);
    const newerTimeout = await screen.findByLabelText("Apply agent timeout (seconds)");
    await user.clear(newerTimeout);
    await user.type(newerTimeout, "1500");
    await user.click(screen.getByRole("button", { name: "Save application runtime" }));
    await screen.findByRole("button", { name: "Saving application runtime" });
    expect(updateSettings).toHaveBeenCalledTimes(1);
    await act(async () => first.reject(new Error("Synthetic first failure")));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(2));
    await act(async () => second.reject(new Error("Synthetic second failure")));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be saved");
    expect(newerTimeout).toHaveValue(1500);
    await user.click(screen.getByRole("button", { name: "Save application runtime" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(persisted.settings.applyTimeoutSeconds).toBe(1500));
  });

  it("preserves a deliberate edit back to the old value in a queued save", async () => {
    const user = userEvent.setup();
    const first = deferred<SettingsResponse>();
    let persisted = applyResponse(900, 5);
    const updateSettings = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async (body: SettingsUpdateRequest) => {
        persisted = applyPatch(persisted, body);
        return persisted;
      });
    const { rerender } = renderWithProviders(<ApplyRuntimeSettingsPanel />, {
      ports: buildTestPorts({ api: { settings: vi.fn(async () => persisted), updateSettings } }),
    });
    const timeout = await screen.findByLabelText("Apply agent timeout (seconds)");
    await user.clear(timeout);
    await user.type(timeout, "1200");
    await user.click(screen.getByRole("button", { name: "Save application runtime" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    rerender(<></>);
    rerender(<ApplyRuntimeSettingsPanel />);
    const later = await screen.findByLabelText("Apply agent timeout (seconds)");
    await user.clear(later);
    await user.type(later, "1000");
    await user.clear(later);
    await user.type(later, "900");
    await user.click(screen.getByRole("button", { name: "Save application runtime" }));
    await screen.findByRole("button", { name: "Saving application runtime" });
    expect(updateSettings).toHaveBeenCalledTimes(1);
    persisted = applyResponse(1200, 5);
    await act(async () => first.resolve(persisted));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(2));
    expect(updateSettings).toHaveBeenNthCalledWith(2, { applyTimeoutSeconds: 900 });
    await waitFor(() => expect(persisted.settings.applyTimeoutSeconds).toBe(900));
  });

  it("does not overwrite a committed field after its acknowledgement is lost", async () => {
    const user = userEvent.setup();
    const first = deferred<void>();
    const refresh = deferred<SettingsResponse>();
    let persisted = applyResponse(900, 5);
    const settings = vi.fn().mockResolvedValueOnce(persisted).mockImplementation(() => refresh.promise);
    const updateSettings = vi.fn()
      .mockImplementationOnce(async (body: SettingsUpdateRequest) => {
        await first.promise;
        persisted = applyResponse(body.applyTimeoutSeconds ?? persisted.settings.applyTimeoutSeconds, body.applyMaxBudgetUsd ?? persisted.settings.applyMaxBudgetUsd);
        throw new Error("Synthetic lost acknowledgement");
      })
      .mockImplementationOnce(async (body: SettingsUpdateRequest) => {
        persisted = applyResponse(body.applyTimeoutSeconds ?? persisted.settings.applyTimeoutSeconds, body.applyMaxBudgetUsd ?? persisted.settings.applyMaxBudgetUsd);
        return persisted;
      });
    const { rerender } = renderWithProviders(<ApplyRuntimeSettingsPanel />, {
      ports: buildTestPorts({ api: { settings, updateSettings } }),
    });
    const budget = await screen.findByLabelText("Maximum AI budget per application (USD)");
    await user.clear(budget);
    await user.type(budget, "6");
    await user.click(screen.getByRole("button", { name: "Save application runtime" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    rerender(<></>);
    rerender(<ApplyRuntimeSettingsPanel />);
    const timeout = await screen.findByLabelText("Apply agent timeout (seconds)");
    await user.clear(timeout);
    await user.type(timeout, "1200");
    await user.click(screen.getByRole("button", { name: "Save application runtime" }));
    await screen.findByRole("button", { name: "Saving application runtime" });
    expect(updateSettings).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve());
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(2));
    expect(updateSettings).toHaveBeenNthCalledWith(2, { applyTimeoutSeconds: 1200 });
    await waitFor(() => expect(persisted.settings.applyTimeoutSeconds).toBe(1200));
    expect(persisted.settings.applyMaxBudgetUsd).toBe(6);
    expect(await screen.findByLabelText("Maximum AI budget per application (USD)")).toHaveValue(6);
    await act(async () => refresh.resolve(persisted));
  });

  it("keeps acknowledged runtime values scoped to the current tenant", async () => {
    const user = userEvent.setup();
    const save = deferred<SettingsResponse>();
    const refresh = deferred<SettingsResponse>();
    const settingsA = vi.fn().mockResolvedValueOnce(applyResponse(1000, 7)).mockImplementation(() => refresh.promise);
    const baseA = buildTestPorts({ api: { settings: settingsA, updateSettings: vi.fn(() => save.promise) } });
    const portsA = { ...baseA, session: { getSession: () => ({ tenantId: "synthetic-a" as TenantId, userId: null }) } };
    const first = renderWithProviders(<ApplyRuntimeSettingsPanel />, { ports: portsA });
    const timeoutA = await screen.findByLabelText("Apply agent timeout (seconds)");
    await waitFor(() => expect(timeoutA).toHaveValue(1000));
    await user.clear(timeoutA);
    await user.type(timeoutA, "1200");
    await user.click(screen.getByRole("button", { name: "Save application runtime" }));
    await screen.findByRole("button", { name: "Saving application runtime" });
    first.unmount();

    const updateB = vi.fn(async () => applyResponse(2100, 9));
    const baseB = buildTestPorts({ api: { settings: vi.fn(async () => applyResponse(2000, 9)), updateSettings: updateB } });
    const portsB = { ...baseB, session: { getSession: () => ({ tenantId: "synthetic-b" as TenantId, userId: null }) } };
    const second = renderWithProviders(<ApplyRuntimeSettingsPanel />, { queryClient: first.queryClient, ports: portsB });
    await waitFor(() => expect(screen.getByLabelText("Apply agent timeout (seconds)")).toHaveValue(2000));
    await user.clear(screen.getByLabelText("Apply agent timeout (seconds)"));
    await user.type(screen.getByLabelText("Apply agent timeout (seconds)"), "2100");
    await user.click(screen.getByRole("button", { name: "Save application runtime" }));
    await waitFor(() => expect(updateB).toHaveBeenCalledTimes(1));
    await act(async () => save.resolve(applyResponse(1201, 7)));
    second.unmount();
    renderWithProviders(<ApplyRuntimeSettingsPanel />, { queryClient: first.queryClient, ports: portsA });
    expect(await screen.findByLabelText("Apply agent timeout (seconds)")).toHaveValue(1201);
    await act(async () => refresh.resolve(applyResponse(1201, 7)));
  });

  it("adopts a successful settings read that completes while the panel is unmounted", async () => {
    const { rerender, queryClient } = renderWithProviders(<ApplyRuntimeSettingsPanel />, {
      ports: buildTestPorts({ api: { settings: vi.fn(async () => applyResponse(900, 5)) } }),
    });
    expect(await screen.findByLabelText("Apply agent timeout (seconds)")).toHaveValue(900);
    rerender(<></>);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: settingsKeys.settings(LOCAL_TENANT), refetchType: "none" });
      await queryClient.fetchQuery({
        queryKey: settingsKeys.settings(LOCAL_TENANT),
        queryFn: async () => applyResponse(1600, 8),
        staleTime: 0,
      });
    });
    rerender(<ApplyRuntimeSettingsPanel />);
    expect(await screen.findByLabelText("Apply agent timeout (seconds)")).toHaveValue(1600);
    expect(screen.getByLabelText("Maximum AI budget per application (USD)")).toHaveValue(8);
  });
});
