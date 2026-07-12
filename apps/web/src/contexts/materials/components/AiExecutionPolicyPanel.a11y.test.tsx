import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { AiExecutionPolicyPanel } from "./AiExecutionPolicyPanel.js";

describe("AI policy settings a11y", () => {
  it("has no axe violations", async () => {
    const view = renderWithProviders(<AiExecutionPolicyPanel />);
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
