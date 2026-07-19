import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { sampleDiscoverySettingsResponse } from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { DiscoveryAutomationSettingsForm } from "./DiscoveryAutomationSettingsPanel.js";

describe("<DiscoveryAutomationSettingsForm>", () => {
  it("shows save and discard only while the form has pending changes", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <DiscoveryAutomationSettingsForm initial={sampleDiscoverySettingsResponse} />,
    );

    const approval = screen.getByRole("checkbox", {
      name: "Require approval before live submit",
    });

    expect(screen.getByLabelText("Minimum fit score")).toHaveAttribute(
      "data-slot",
      "input",
    );
    expect(approval).toHaveAttribute("data-slot", "checkbox");
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard changes" })).not.toBeInTheDocument();
    expect(screen.queryByText("No unsaved changes")).not.toBeInTheDocument();

    await user.click(approval);

    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard changes" })).toBeEnabled();
  });
});
