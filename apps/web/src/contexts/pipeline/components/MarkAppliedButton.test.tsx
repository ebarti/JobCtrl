import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { MarkAppliedButton } from "./MarkAppliedButton.js";

describe("<MarkAppliedButton>", () => {
  it("renders the configured label", () => {
    renderWithProviders(<MarkAppliedButton jobId="job-1" />);
    expect(screen.getByRole("button", { name: "applied" })).toBeInTheDocument();
  });
});
