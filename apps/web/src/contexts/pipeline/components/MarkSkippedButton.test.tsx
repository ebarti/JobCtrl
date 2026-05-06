import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { MarkSkippedButton } from "./MarkSkippedButton.js";

describe("<MarkSkippedButton>", () => {
  it("renders the skip label", () => {
    renderWithProviders(<MarkSkippedButton jobId="job-1" />);
    expect(screen.getByRole("button", { name: "skip" })).toBeInTheDocument();
  });
});
