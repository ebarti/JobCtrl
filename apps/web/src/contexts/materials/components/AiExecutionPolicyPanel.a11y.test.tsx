import { screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { AiExecutionPolicyPanel } from "./AiExecutionPolicyPanel.js";

describe("<AiExecutionPolicyPanel> accessibility", () => {
  it("labels the finishing policy and its description without axe violations", async () => {
    const view = renderWithProviders(<AiExecutionPolicyPanel />);
    expect(await screen.findByRole("checkbox", { name: "Extra résumé polish" })).not.toBeChecked();
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
