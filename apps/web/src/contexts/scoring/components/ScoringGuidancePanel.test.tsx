import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { ScoringGuidancePanel } from "./ScoringGuidancePanel.js";

describe("<ScoringGuidancePanel>", () => {
  it("does not expose the internal scoring context as card metadata", async () => {
    renderWithProviders(<ScoringGuidancePanel />);
    expect(screen.queryByText("scoring", { selector: ".meta" })).not.toBeInTheDocument();
    expect(await screen.findByLabelText("Scoring priorities")).toBeInTheDocument();
    expect(screen.queryByText("scoring", { selector: ".meta" })).not.toBeInTheDocument();
  });

  it("exposes both previously hidden scoring guidance fields", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ScoringGuidancePanel />);
    await user.click(screen.getByRole("button", { name: /^Scoring guidance\b/i }));
    const scoringPriorities = await screen.findByLabelText("Scoring priorities");
    const targetGuidance = screen.getByLabelText("Target role guidance");

    expect(scoringPriorities).toHaveValue("Platform reliability and team leadership.");
    expect(targetGuidance).toHaveValue("Director-plus infrastructure roles.");
    expect(scoringPriorities).toHaveAttribute("data-slot", "textarea");
    expect(targetGuidance).toHaveAttribute("data-slot", "textarea");
    expect(screen.getByRole("button", { name: "Save scoring guidance" })).toHaveAttribute(
      "data-slot",
      "button",
    );
    expect(screen.getByRole("button", { name: "Save scoring guidance" })).toBeDisabled();
    await user.type(targetGuidance, " Prefer regulated industries.");
    expect(screen.getByRole("button", { name: "Save scoring guidance" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Discard changes" })).toBeEnabled();
  });
});
