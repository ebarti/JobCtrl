import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { ApplyRuntimeSettingsPanel } from "./ApplyRuntimeSettingsPanel.js";

describe("<ApplyRuntimeSettingsPanel>", () => {
  it("does not expose the internal apply context as card metadata", async () => {
    renderWithProviders(<ApplyRuntimeSettingsPanel />);
    expect(screen.queryByText("apply", { selector: ".meta" })).not.toBeInTheDocument();
    expect(await screen.findByLabelText("Maximum AI budget per application (USD)")).toBeInTheDocument();
    expect(screen.queryByText("apply", { selector: ".meta" })).not.toBeInTheDocument();
  });

  it("distinguishes the zero-dollar cap and agent timeout", async () => {
    renderWithProviders(<ApplyRuntimeSettingsPanel />);
    expect(await screen.findByLabelText("Maximum AI budget per application (USD)")).toHaveValue(5);
    expect(screen.getByText(/zero-dollar cap, not unlimited/i)).toBeInTheDocument();
    expect(screen.getByText(/separate from Temporal activity timeouts/i)).toBeInTheDocument();
  });
});
