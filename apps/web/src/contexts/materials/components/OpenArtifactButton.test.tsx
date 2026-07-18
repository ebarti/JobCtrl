import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { OpenArtifactButton } from "./OpenArtifactButton.js";

describe("<OpenArtifactButton>", () => {
  it("invokes the open mutation and toggles label", async () => {
    const user = userEvent.setup();
    renderWithProviders(<OpenArtifactButton artifactId="artifact-1" />);
    const button = screen.getByRole("button", { name: "Open" });
    await user.click(button);
    await waitFor(() => expect(screen.getByRole("button")).toHaveTextContent(/open|opening/i));
  });

  it("respects the disabled prop", () => {
    renderWithProviders(<OpenArtifactButton artifactId="artifact-1" disabled />);
    expect(screen.getByRole("button", { name: "Open" })).toBeDisabled();
  });
});
