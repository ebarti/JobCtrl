import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { sampleProfileResponse } from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { ProfileForm } from "./profile-form.js";

describe("<ProfileForm>", () => {
  it("keeps preference controls out of the profile section", async () => {
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} />, {
      withRouter: true,
    });

    expect(await screen.findByRole("heading", { name: "Personal information" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Application defaults" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Target role")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "preferences" })).not.toBeInTheDocument();
  });

  it("renders preferences as their own section", async () => {
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} section="preferences" />);

    expect(await screen.findByRole("heading", { name: "Application defaults" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Target preferences" })).toBeInTheDocument();
    expect(screen.getByLabelText("Target role")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Personal information" })).not.toBeInTheDocument();
  });

  it("clamps max bullets to the allowed positive range", async () => {
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} section="preferences" />);
    const input = await screen.findByLabelText("Max bullets per role");

    fireEvent.change(input, { target: { value: "-1" } });

    expect(input).toHaveValue(1);

    fireEvent.change(input, { target: { value: "100" } });

    expect(input).toHaveValue(99);
  });
});
