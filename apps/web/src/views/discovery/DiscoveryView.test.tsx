import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../test/render.js";
import { DiscoveryView } from "./DiscoveryView.js";

describe("DiscoveryView", () => {
  it("renders discovery controls as tabs with a source registry table", async () => {
    renderWithProviders(<DiscoveryView />);

    expect(
      await screen.findByRole("heading", { level: 2, name: "Target search" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 3, name: "Target search" })).not.toBeInTheDocument();
    expect(
      await screen.findByRole("group", { name: "Target tracks" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Management" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Director of Engineering" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Automation settings" })).toBeInTheDocument();
    expect(screen.getByLabelText("Minimum fit score")).toBeInTheDocument();
    expect(screen.getByLabelText("Auto apply")).toBeInTheDocument();
    expect(screen.queryByText("Ranking priorities")).not.toBeInTheDocument();
    expect(screen.queryByText("Exclusions")).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Runtime settings" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Indeed" })).toBeInTheDocument();
    expect(screen.getByLabelText("Results per board")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Discovery controls" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "Source registry" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "Source locator" }),
    ).toBeInTheDocument();

    await screen.findByRole("table");
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: /filter company column/i }),
    );
    expect(screen.getByLabelText("Company filter text")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /close/i }));
    await user.click(
      screen.getByRole("button", { name: /filter state column/i }),
    );
    expect(screen.getByLabelText("State filter text")).toBeInTheDocument();
  });

  it("preserves an in-progress automation value across disclosure toggles", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DiscoveryView />);

    const minimumFitScore = await screen.findByLabelText("Minimum fit score");
    await user.clear(minimumFitScore);
    await user.type(minimumFitScore, "9");

    const trigger = screen.getByRole("button", { name: /^Automation settings\b/i });
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(minimumFitScore).toBeInTheDocument();
    expect(minimumFitScore).toHaveValue(9);

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Minimum fit score")).toBe(minimumFitScore);
    expect(minimumFitScore).toHaveValue(9);
  });
});
