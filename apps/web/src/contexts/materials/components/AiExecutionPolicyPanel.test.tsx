import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { AiExecutionPolicyPanel } from "./AiExecutionPolicyPanel.js";

describe("<AiExecutionPolicyPanel>", () => {
  it("uses product provider names and catalog-backed model choices", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AiExecutionPolicyPanel />);
    expect(await screen.findByRole("group", { name: "Employer analysis perspectives" })).toBeInTheDocument();
    expect(screen.getByLabelText("Google")).toBeChecked();
    expect(screen.queryByText(/Antigravity/i)).not.toBeInTheDocument();
    await user.click(screen.getByLabelText("Primary tailoring generator"));
    expect((await screen.findAllByRole("option")).some((option) => option.textContent?.includes("Claude"))).toBe(true);
  });
});
