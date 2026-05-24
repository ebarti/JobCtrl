import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../test/render.js";
import { DiscoveryView } from "./DiscoveryView.js";

describe("DiscoveryView", () => {
  it("renders discovery controls as tabs with a source registry table", async () => {
    renderWithProviders(<DiscoveryView />);

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
