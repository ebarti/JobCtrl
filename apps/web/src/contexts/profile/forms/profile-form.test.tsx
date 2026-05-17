import { ProfileSchema, type ProfileUpdateRequest } from "@jobhunter/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { sampleProfileResponse } from "../../../test/fixtures/projections.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { renderWithProviders } from "../../../test/render.js";
import { ProfileForm } from "./profile-form.js";

describe("<ProfileForm>", () => {
  it("saves edited persisted profile fields and resets to the saved response", async () => {
    const user = userEvent.setup();
    const editedFullName = "Jordan Saved";
    const initialProfile = ProfileSchema.parse(sampleProfileResponse.profile);
    const savedProfile = {
      ...sampleProfileResponse,
      profile: {
        ...initialProfile,
        personal: {
          ...initialProfile.personal,
          full_name: editedFullName,
        },
      },
    };
    const updateProfile = vi.fn(async (_body: ProfileUpdateRequest) => savedProfile);

    renderWithProviders(<ProfileForm initial={sampleProfileResponse} />, {
      ports: buildTestPorts({ api: { updateProfile } }),
      withRouter: true,
    });

    const fullName = await screen.findByLabelText("Full name");
    const saveButton = screen.getByRole("button", { name: /^save all$/i });
    const discardButton = screen.getByRole("button", { name: /^discard all$/i });

    expect(saveButton).toBeDisabled();
    expect(discardButton).toBeDisabled();

    await user.clear(fullName);
    await user.type(fullName, editedFullName);

    await waitFor(() => expect(saveButton).toBeEnabled());
    expect(discardButton).toBeEnabled();

    await user.click(saveButton);

    expect(await screen.findByText("profile saved")).toBeInTheDocument();
    expect(updateProfile).toHaveBeenCalledTimes(1);
    const submitted = updateProfile.mock.calls[0]?.[0];
    if (!submitted?.profileText) {
      throw new Error("Expected profileText to be submitted");
    }
    const submittedProfile = ProfileSchema.parse(JSON.parse(submitted.profileText));
    expect(submittedProfile.personal.full_name).toBe(editedFullName);
    expect(fullName).toHaveValue(editedFullName);
    await waitFor(() => expect(saveButton).toBeDisabled());
    expect(discardButton).toBeDisabled();
  });

  it("discards edited persisted profile fields without saving", async () => {
    const user = userEvent.setup();
    const initialProfile = ProfileSchema.parse(sampleProfileResponse.profile);
    const updateProfile = vi.fn(async (_body: ProfileUpdateRequest) => sampleProfileResponse);

    renderWithProviders(<ProfileForm initial={sampleProfileResponse} />, {
      ports: buildTestPorts({ api: { updateProfile } }),
      withRouter: true,
    });

    const fullName = await screen.findByLabelText("Full name");
    const saveButton = screen.getByRole("button", { name: /^save all$/i });
    const discardButton = screen.getByRole("button", { name: /^discard all$/i });

    await user.clear(fullName);
    await user.type(fullName, "Jordan Unsaved");

    await waitFor(() => expect(discardButton).toBeEnabled());
    expect(saveButton).toBeEnabled();

    await user.click(discardButton);

    expect(fullName).toHaveValue(initialProfile.personal.full_name);
    await waitFor(() => expect(saveButton).toBeDisabled());
    expect(discardButton).toBeDisabled();
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it("keeps preference controls out of the profile section", async () => {
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} />, {
      withRouter: true,
    });

    expect(await screen.findByRole("heading", { name: "Personal information" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Application defaults" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Target role")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "preferences" })).not.toBeInTheDocument();
  });

  it("does not expose raw profile source editors", async () => {
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} />, {
      withRouter: true,
    });

    expect(await screen.findByRole("heading", { name: "Personal information" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "source" })).not.toBeInTheDocument();
    expect(screen.queryByText("profile.json")).not.toBeInTheDocument();
    expect(screen.queryByText("resume_style.json")).not.toBeInTheDocument();
    expect(screen.queryByText("resume_template.tex")).not.toBeInTheDocument();
  });

  it("does not expose internal IDs or job-site passwords in the profile editor", async () => {
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} />, {
      withRouter: true,
    });

    expect(await screen.findByRole("heading", { name: "Experience entries" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Entry ID")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Application password")).not.toBeInTheDocument();
  });

  it("adds a visible editable bullet row", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} />, {
      withRouter: true,
    });

    await user.click(await screen.findByRole("button", { name: /add bullet/i }));

    expect(screen.getByLabelText("Bullet 3")).toBeInTheDocument();
  });

  it("hides end date controls while an experience is marked present", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} />, {
      withRouter: true,
    });

    await user.click(await screen.findByLabelText("Present"));

    expect(screen.queryByLabelText("End month")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("End year")).not.toBeInTheDocument();
  });

  it("blocks saving when an experience end date is before the start date", async () => {
    const user = userEvent.setup();
    const updateProfile = vi.fn(async () => sampleProfileResponse);
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} />, {
      ports: buildTestPorts({ api: { updateProfile } }),
      withRouter: true,
    });

    await user.selectOptions(await screen.findByLabelText("End year"), "2021");
    await user.click(screen.getByRole("button", { name: /^save all$/i }));

    expect(await screen.findAllByText(/End date must be after start date/i)).not.toHaveLength(0);
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it("renders preferences as their own section", async () => {
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} section="preferences" />);

    expect(await screen.findByRole("heading", { name: "Application defaults" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Target search" })).toBeInTheDocument();
    expect(screen.getByLabelText("Target roles 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Target location 1")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Target work model 1" })).toBeInTheDocument();
    expect(screen.getByLabelText("Remote")).toBeInTheDocument();
    expect(screen.getByLabelText("Hybrid")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Personal information" })).not.toBeInTheDocument();
  });

  it("adds and focuses the next target role with Enter", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} section="preferences" />);

    await user.type(await screen.findByLabelText("Target roles 1"), "Director{Enter}");

    expect(screen.getByLabelText("Target roles 2")).toHaveFocus();
  });

  it("preserves spaces while editing target roles", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} section="preferences" />);

    const input = await screen.findByLabelText("Target roles 1");
    await user.type(input, "Director of Engineering");

    expect(input).toHaveValue("Director of Engineering");
  });

  it("adds and focuses the next target location with Enter", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} section="preferences" />);

    await user.type(await screen.findByLabelText("Target location 1"), "Barcelona{Enter}");

    expect(screen.getByLabelText("Target location 2")).toHaveFocus();
    expect(screen.getByRole("group", { name: "Target work model 2" })).toBeInTheDocument();
  });

  it("allows multiple work models for a target location", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} section="preferences" />);

    await user.click(await screen.findByLabelText("Remote"));
    await user.click(screen.getByLabelText("Hybrid"));

    expect(screen.getByLabelText("Remote")).toBeChecked();
    expect(screen.getByLabelText("Hybrid")).toBeChecked();
  });

  it("clamps max bullets to the allowed positive range", async () => {
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} />, {
      withRouter: true,
    });
    const input = await screen.findByLabelText("Max bullets per role");

    fireEvent.change(input, { target: { value: "-1" } });

    expect(input).toHaveValue(1);

    fireEvent.change(input, { target: { value: "100" } });

    expect(input).toHaveValue(99);
  });
});
