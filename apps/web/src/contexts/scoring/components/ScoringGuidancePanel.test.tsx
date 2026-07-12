import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { ScoringGuidancePanel } from "./ScoringGuidancePanel.js";

describe("<ScoringGuidancePanel>", () => {
  it("exposes both previously hidden scoring guidance fields", async () => {
    renderWithProviders(<ScoringGuidancePanel />);
    expect(await screen.findByLabelText("Scoring priorities")).toHaveValue("Platform reliability and team leadership.");
    expect(screen.getByLabelText("Target role guidance")).toHaveValue("Director-plus infrastructure roles.");
  });
});
