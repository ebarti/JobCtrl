import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../test/render.js";
import { DiscoveryView } from "./DiscoveryView.js";

describe("DiscoveryView", () => {
  it("renders discovery controls as tabs with a source registry table", async () => {
    renderWithProviders(<DiscoveryView />);

    expect(await screen.findByRole("heading", { name: "Target search" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Target tracks" })).toBeInTheDocument();
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
});
