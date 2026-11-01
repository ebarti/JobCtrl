import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { MarkSkippedButton } from "./MarkSkippedButton.js";

describe("<MarkSkippedButton>", () => {
  it("renders its shared control primitive", () => {
    renderWithProviders(<MarkSkippedButton jobId="job-1" />);
    const button = screen.getByRole("button", { name: "Skip" });
    expect(button).toHaveAttribute("data-slot", "button");
    expect(button).toHaveAttribute("data-typography", "control");
  });
});

it("describes Skip as a local stop without promising provider cancellation", () => {
  renderWithProviders(<MarkSkippedButton jobId="job-1" />);
  expect(screen.getByRole("button", { name: "Skip" })).toHaveAccessibleDescription(
    "Skip stops future Apply locally. In-flight submissions may still complete.");
});
