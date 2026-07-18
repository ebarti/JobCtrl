import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { sampleDiscoverySettingsResponse } from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { DiscoveryAutomationSettingsForm } from "./DiscoveryAutomationSettingsPanel.js";

describe("<DiscoveryAutomationSettingsForm>", () => {
  it("uses shared form controls and a stable save and discard decision bar", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <DiscoveryAutomationSettingsForm initial={sampleDiscoverySettingsResponse} />,
    );

    const save = screen.getByRole("button", { name: "Save changes" });
    const approval = screen.getByRole("checkbox", {
      name: "Require approval before live submit",
    });

    expect(screen.getByLabelText("Minimum fit score")).toHaveAttribute(
      "data-slot",
      "input",
    );
    expect(approval).toHaveAttribute("data-slot", "checkbox");
    expect(save).toBeDisabled();
    expect(screen.getByText("No unsaved changes")).toBeInTheDocument();

    await user.click(approval);

    expect(save).toBeEnabled();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard changes" })).toBeEnabled();
  });
});
