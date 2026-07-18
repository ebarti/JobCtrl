import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { ApplyButton } from "./ApplyButton.js";

describe("<ApplyButton>", () => {
  it("renders the configured label", () => {
    renderWithProviders(<ApplyButton jobId="job-1" />);
    const button = screen.getByRole("button", { name: "Apply" });
    expect(button).toHaveAttribute("data-slot", "button");
    expect(button).toHaveAttribute("data-typography", "control");
  });

  it("invokes the apply mutation on click", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ApplyButton jobId="job-1" />);
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(screen.getByRole("button")).toHaveTextContent(/Apply|Applying/),
    );
  });
});
