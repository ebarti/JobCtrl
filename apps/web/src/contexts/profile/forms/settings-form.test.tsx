import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sampleSettingsResponse } from "../../../test/fixtures/projections.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { renderWithProviders } from "../../../test/render.js";
import { SettingsForm } from "./settings-form.js";
import type { SettingsResponse } from "../../operations/types.js";

describe("<SettingsForm>", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("autosaves edited settings after five seconds", async () => {
    vi.useFakeTimers();
    const updateSettings = vi.fn(async (request): Promise<SettingsResponse> => ({
      ok: true,
      settings: { ...sampleSettingsResponse.settings, ...request },
      paths: sampleSettingsResponse.paths,
    }));
    renderWithProviders(<SettingsForm initial={sampleSettingsResponse.settings} />, {
      ports: buildTestPorts({ api: { updateSettings } }),
    });

    fireEvent.change(screen.getByLabelText("Target role"), {
      target: { value: "Engineering Director" },
    });

    act(() => vi.advanceTimersByTime(4_999));
    expect(updateSettings).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });

    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ targetRole: "Engineering Director" }),
    );
  });

  it("keeps newer edits when an autosave response returns for an older snapshot", async () => {
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

    const targetRole = screen.getByLabelText("Target role");
    fireEvent.change(targetRole, {
      target: { value: "Engineering Director" },
    });

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(updateSettings).toHaveBeenCalledTimes(1);

    fireEvent.change(targetRole, {
      target: { value: "VP Engineering" },
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

    expect(targetRole).toHaveValue("VP Engineering");
    expect(screen.getByText("saved; newer changes pending")).toBeInTheDocument();
  });

  it("does not reset dirty edits when a saved autosave snapshot reaches the initial props", async () => {
    const { rerender } = renderWithProviders(<SettingsForm initial={sampleSettingsResponse.settings} />);

    const targetRole = screen.getByLabelText("Target role");
    fireEvent.change(targetRole, {
      target: { value: "VP Engineering" },
    });

    rerender(
      <SettingsForm
        initial={{
          ...sampleSettingsResponse.settings,
          targetRole: "Engineering Director",
        }}
      />,
    );

    expect(targetRole).toHaveValue("VP Engineering");
  });

  it("undos checkbox setting changes with the keyboard shortcut", async () => {
    renderWithProviders(<SettingsForm initial={sampleSettingsResponse.settings} />);

    const autoApply = screen.getByLabelText("Auto apply");
    fireEvent.click(autoApply);
    await waitFor(() => expect(autoApply).toBeChecked());

    fireEvent.keyDown(autoApply, { key: "z", metaKey: true });

    await waitFor(() => expect(autoApply).not.toBeChecked());
  });
});
