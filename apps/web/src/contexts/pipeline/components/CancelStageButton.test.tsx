import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { CancelStageButton } from "./CancelStageButton.js";

describe("<CancelStageButton>", () => {
  it("renders the cancel label", () => {
    renderWithProviders(<CancelStageButton jobId="job-1" stage="apply" />);
    expect(screen.getByRole("button", { name: "cancel" })).toBeInTheDocument();
  });
});
