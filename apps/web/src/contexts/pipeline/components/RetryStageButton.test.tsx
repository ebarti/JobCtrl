import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { RetryStageButton } from "./RetryStageButton.js";

describe("<RetryStageButton>", () => {
  it("renders the retry label", () => {
    renderWithProviders(<RetryStageButton jobId="job-1" stage="tailor" />);
    expect(screen.getByRole("button", { name: "retry" })).toBeInTheDocument();
  });
});
