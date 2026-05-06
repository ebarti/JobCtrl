import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { CancelApplyButton } from "./CancelApplyButton.js";

describe("<CancelApplyButton>", () => {
  it("renders the cancel label and is enabled by default", () => {
    renderWithProviders(<CancelApplyButton jobId="job-1" runId="run-1" />);
    expect(screen.getByRole("button", { name: /cancel apply/i })).toBeEnabled();
  });
});
