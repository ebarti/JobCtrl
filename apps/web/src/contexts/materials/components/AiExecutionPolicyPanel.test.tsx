import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { AiExecutionPolicyPanel } from "./AiExecutionPolicyPanel.js";

describe("<AiExecutionPolicyPanel>", () => {
  it("does not expose the internal materials context as card metadata", async () => {
    renderWithProviders(<AiExecutionPolicyPanel />);
    expect(screen.queryByText("materials", { selector: ".meta" })).not.toBeInTheDocument();
    expect(await screen.findByRole("group", { name: "Employer analysis perspectives" })).toBeInTheDocument();
    expect(screen.queryByText("materials", { selector: ".meta" })).not.toBeInTheDocument();
  });

  it("uses product provider names and catalog-backed model choices", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AiExecutionPolicyPanel />);
    expect(await screen.findByRole("group", { name: "Employer analysis perspectives" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Google" })).toBeChecked();
    expect(screen.queryByText(/Antigravity/i)).not.toBeInTheDocument();
    await user.click(screen.getByLabelText("Primary tailoring generator"));
    expect((await screen.findAllByRole("option")).some((option) => option.textContent?.includes("Claude"))).toBe(true);
  });

  it("uses the shared field, checkbox, input, and button primitives", async () => {
    renderWithProviders(<AiExecutionPolicyPanel />);

    await screen.findByRole("group", { name: "Employer analysis perspectives" });

    expect(screen.getByRole("checkbox", { name: "Claude" })).toHaveAttribute("data-slot", "checkbox");
    expect(screen.getByLabelText("Minimum judge score")).toHaveAttribute("data-slot", "input");
    expect(screen.getByRole("button", { name: "Save AI policy" })).toHaveAttribute(
      "data-slot",
      "button",
    );
    expect(screen.getByRole("button", { name: "Save AI policy" })).toBeDisabled();
    await userEvent.setup().click(screen.getByRole("checkbox", { name: "Google" }));
    expect(screen.getByRole("button", { name: "Save AI policy" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Discard changes" })).toBeEnabled();
  });
});
