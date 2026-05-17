import type { SettingsUpdateRequest } from "@jobhunter/contracts";
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { sampleSettingsResponse } from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { SettingsForm } from "./settings-form.js";

describe("<SettingsForm>", () => {
  it("saves edited persisted settings fields and resets to the saved response", async () => {
    const user = userEvent.setup();
    const editedTargetRole = "Director of Platform";
    const savedSettings = {
      ...sampleSettingsResponse,
      settings: {
        ...sampleSettingsResponse.settings,
        targetRole: editedTargetRole,
      },
    };
    const updateSettings = vi.fn(async (_body: SettingsUpdateRequest) => savedSettings);

    renderWithProviders(<SettingsForm initial={sampleSettingsResponse.settings} />, {
      ports: buildTestPorts({ api: { updateSettings } }),
    });

    const targetRole = await screen.findByLabelText("Target role");
    const saveButton = screen.getByRole("button", { name: /^save$/i });
    const resetButton = screen.getByRole("button", { name: /^reset$/i });

    expect(saveButton).toBeDisabled();
    expect(resetButton).toBeDisabled();

    await user.clear(targetRole);
    await user.type(targetRole, editedTargetRole);

    await waitFor(() => expect(saveButton).toBeEnabled());
    expect(resetButton).toBeEnabled();

    await user.click(saveButton);

    expect(await screen.findByText("settings saved")).toBeInTheDocument();
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings.mock.calls[0]?.[0].targetRole).toBe(editedTargetRole);
    expect(targetRole).toHaveValue(editedTargetRole);
    await waitFor(() => expect(saveButton).toBeDisabled());
    expect(resetButton).toBeDisabled();
  });

  it("resets edited persisted settings fields without saving", async () => {
    const user = userEvent.setup();
    const updateSettings = vi.fn(async (_body: SettingsUpdateRequest) => sampleSettingsResponse);

    renderWithProviders(<SettingsForm initial={sampleSettingsResponse.settings} />, {
      ports: buildTestPorts({ api: { updateSettings } }),
    });

    const targetRole = await screen.findByLabelText("Target role");
    const saveButton = screen.getByRole("button", { name: /^save$/i });
    const resetButton = screen.getByRole("button", { name: /^reset$/i });

    await user.clear(targetRole);
    await user.type(targetRole, "Unsaved Role");

    await waitFor(() => expect(resetButton).toBeEnabled());
    expect(saveButton).toBeEnabled();

    await user.click(resetButton);

    expect(targetRole).toHaveValue(sampleSettingsResponse.settings.targetRole);
    await waitFor(() => expect(saveButton).toBeDisabled());
    expect(resetButton).toBeDisabled();
    expect(updateSettings).not.toHaveBeenCalled();
  });
});
