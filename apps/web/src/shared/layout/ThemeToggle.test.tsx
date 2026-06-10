import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { renderWithProviders } from "../../test/render.js";
import { useUiPreferencesStore } from "../stores/ui-preferences.js";
import { ThemeToggle } from "./ThemeToggle.js";

describe("<ThemeToggle>", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    useUiPreferencesStore.setState({ theme: "light", density: "regular" });
  });

  it("keeps its accessible name and toggles the persisted theme", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ThemeToggle />);

    const toggle = await screen.findByRole("button", { name: "Switch to dark theme" });
    await waitFor(() => expect(document.documentElement).toHaveAttribute("data-theme", "light"));

    await user.click(toggle);

    expect(useUiPreferencesStore.getState().theme).toBe("dark");
    expect(screen.getByRole("button", { name: "Switch to light theme" })).toBeInTheDocument();
    await waitFor(() => expect(document.documentElement).toHaveAttribute("data-theme", "dark"));
  });
});
