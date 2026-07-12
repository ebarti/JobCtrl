import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { ApplyRuntimeSettingsPanel } from "./ApplyRuntimeSettingsPanel.js";

describe("<ApplyRuntimeSettingsPanel>", () => {
  it("distinguishes the zero-dollar cap and agent timeout", async () => {
    renderWithProviders(<ApplyRuntimeSettingsPanel />);
    expect(await screen.findByLabelText("Maximum AI budget per application (USD)")).toHaveValue(5);
    expect(screen.getByText(/zero-dollar cap, not unlimited/i)).toBeInTheDocument();
    expect(screen.getByText(/separate from Temporal activity timeouts/i)).toBeInTheDocument();
  });
});
