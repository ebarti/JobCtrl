import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { RetryStageButton } from "./RetryStageButton.js";

describe("<RetryStageButton>", () => {
  it("renders its shared control primitive", () => {
    renderWithProviders(<RetryStageButton jobId="job-1" stage="tailor" />);
    const button = screen.getByRole("button", { name: "Retry" });
    expect(button).toHaveAttribute("data-slot", "button");
    expect(button).toHaveAttribute("data-typography", "control");
  });
});
