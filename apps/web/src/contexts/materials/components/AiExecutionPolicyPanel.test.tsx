import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { AiExecutionPolicyPanel } from "./AiExecutionPolicyPanel.js";

describe("<AiExecutionPolicyPanel>", () => {
  it("uses product provider names and catalog-backed model choices", async () => {
    renderWithProviders(<AiExecutionPolicyPanel />);
    expect(await screen.findByRole("group", { name: "Employer analysis perspectives" })).toBeInTheDocument();
    expect(screen.getByLabelText("Google")).toBeChecked();
    expect(screen.queryByText(/Antigravity/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Primary tailoring generator")).toHaveTextContent("Claude");
  });
});
