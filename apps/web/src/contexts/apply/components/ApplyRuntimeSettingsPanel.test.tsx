import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { ApplyRuntimeSettingsPanel } from "./ApplyRuntimeSettingsPanel.js";

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
});
