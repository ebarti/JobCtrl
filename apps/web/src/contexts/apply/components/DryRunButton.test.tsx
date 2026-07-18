import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { DryRunButton } from "./DryRunButton.js";

describe("<DryRunButton>", () => {
  it("renders the configured label", () => {
    renderWithProviders(<DryRunButton jobId="job-1" />);
    const button = screen.getByRole("button", { name: "Dry run" });
    expect(button).toHaveAttribute("data-slot", "button");
    expect(button).toHaveAttribute("data-typography", "control");
  });
});
