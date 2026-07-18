import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  sampleProfileResponse,
} from "../../../test/fixtures/projections.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { renderWithProviders } from "../../../test/render.js";
import { ProfileForm } from "./profile-form.js";

async function openExperienceEntries(user: ReturnType<typeof userEvent.setup>) {
  const disclosure = await screen.findByRole("button", {
    name: /^Experience entries\b/i,
  });
  if (disclosure.getAttribute("aria-expanded") === "false") {
    await user.click(disclosure);
  }
}

describe("<ProfileForm>", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps preference controls out of the profile section", async () => {
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} />, {
      withRouter: true,
    });

    expect(await screen.findByRole("heading", { name: "Personal information" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Application configuration" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Target role")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "preferences" })).not.toBeInTheDocument();
  });

  it("uses a stable shared save and discard bar with explicit unchanged state", async () => {
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} />, {
      withRouter: true,
    });

    const save = await screen.findByRole("button", { name: "Save changes" });
    const discard = screen.getByRole("button", { name: "Discard changes" });

    expect(screen.getByRole("link", { name: "Import resume" })).toHaveAttribute(
      "data-slot",
      "button",
    );
    expect(save).toHaveAttribute("data-slot", "button");
    expect(save).toBeDisabled();
    expect(discard).toBeDisabled();
    expect(screen.getByText("No unsaved changes")).toBeInTheDocument();
  });

  it("keeps the address field editable when Google Maps is not configured", async () => {
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} />, {
      withRouter: true,
    });

    const address = await screen.findByLabelText("Address");
    expect(address).toHaveAttribute("type", "search");
    expect(address).toHaveAttribute("autocomplete", "street-address");
    expect(screen.getByText("manual")).toBeInTheDocument();
  });

  it("does not expose raw profile source editors", async () => {
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} />, {
      withRouter: true,
    });

    expect(await screen.findByRole("heading", { name: "Personal information" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "source" })).not.toBeInTheDocument();
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

    await openExperienceEntries(user);
    await user.click(await screen.findByRole("button", { name: /add bullet/i }));

    expect(screen.getByLabelText("Bullet 3")).toBeInTheDocument();
  });

  it("hides end date controls while an experience is marked present", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} />, {
      withRouter: true,
    });

    await openExperienceEntries(user);
    await user.click(await screen.findByRole("checkbox", { name: "Present" }));

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

    await openExperienceEntries(user);
    await user.click(
      await screen.findByRole("combobox", { name: "End year" }),
    );
    await user.click(await screen.findByRole("option", { name: "2021" }));
    await user.click(screen.getByRole("button", { name: /^save changes$/i }));

    expect(await screen.findAllByText(/End date must be after start date/i)).not.toHaveLength(0);
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it("renders preferences as their own section", async () => {
    renderWithProviders(
      <ProfileForm
        initial={sampleProfileResponse}
        section="preferences"
      />,
    );

    expect(
      await screen.findByRole("heading", { level: 3, name: "Application configuration" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Location filter")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Tailoring controls" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Target search" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Target tracks" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Personal information" })).not.toBeInTheDocument();
  });

  it("does not expose the legacy dashboard location filter in Preferences", async () => {
    renderWithProviders(
      <ProfileForm
        initial={sampleProfileResponse}
        section="preferences"
      />,
    );

    expect(screen.queryByLabelText("Location filter")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Target location 1")).not.toBeInTheDocument();
  });

  it("renders target search as a discovery settings section", async () => {
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} section="target-search" />);

    expect(screen.getByRole("heading", { name: "Target search" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Target tracks" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Individual Contributor" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Management" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Executive" })).toBeInTheDocument();
    const seniorityGroup = screen.getByRole("group", { name: "Seniority floors" });
    const seniorityLevels = [
      "Junior IC",
      "Mid IC",
      "Senior IC",
      "Staff IC",
      "Principal IC",
      "Manager",
      "Senior Manager",
      "Director",
      "VP",
      "SVP",
      "C-Level",
    ];
    for (const level of seniorityLevels) {
      expect(screen.getByRole("checkbox", { name: level })).toBeInTheDocument();
    }
    expect(within(seniorityGroup).getAllByRole("checkbox")).toEqual(
      seniorityLevels.map((level) => screen.getByRole("checkbox", { name: level })),
    );
    expect(screen.queryByRole("checkbox", { name: /\b(?:engineer|engineering|cto)\b/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Role areas 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Role areas 1")).toHaveAttribute("placeholder", "Engineering, security, platform");
    expect(screen.getByLabelText("Specializations 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Target roles 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Target location 1")).toBeInTheDocument();
    expect(screen.getByText("Locations and work models")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Target work model 1" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Remote" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Hybrid" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Application configuration" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Personal information" })).not.toBeInTheDocument();
  });

  it("saves target tracks and seniority floors as canonical values", async () => {
    const user = userEvent.setup();
    const updateProfile = vi.fn(async (request) => ({
      ...sampleProfileResponse,
      profile: JSON.parse(request.profileText),
    }));
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} section="target-search" />, {
      ports: buildTestPorts({ api: { updateProfile } }),
    });

    await user.click(await screen.findByRole("checkbox", { name: "Management" }));
    await user.click(screen.getByRole("checkbox", { name: "Executive" }));
    await user.click(screen.getByRole("checkbox", { name: "Senior Manager" }));
    await user.click(screen.getByRole("checkbox", { name: "C-Level" }));
    await user.click(screen.getByRole("button", { name: /^save changes$/i }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    const request = updateProfile.mock.calls[0]?.[0];
    const profile = JSON.parse(request.profileText);
    expect(profile.experience.target_track).toBe("management; executive");
    expect(profile.experience.target_seniority_floor).toBe("senior_manager; c_level");
  });

  it("maps legacy engineering-specific seniority values onto the canonical ladder", async () => {
    const user = userEvent.setup();
    const initial = JSON.parse(JSON.stringify(sampleProfileResponse));
    initial.profile.experience = {
      target_seniority_floor: "engineer; cto",
    };
    const updateProfile = vi.fn(async (request) => ({
      ...sampleProfileResponse,
      profile: JSON.parse(request.profileText),
    }));
    renderWithProviders(<ProfileForm initial={initial} section="target-search" />, {
      ports: buildTestPorts({ api: { updateProfile } }),
    });

    expect(screen.getByRole("checkbox", { name: "Mid IC" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "C-Level" })).toBeChecked();
    expect(screen.queryByText("Unsupported saved values")).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Senior IC" }));
    await user.click(screen.getByRole("button", { name: /^save changes$/i }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    const request = updateProfile.mock.calls[0]?.[0];
    const profile = JSON.parse(request.profileText);
    expect(profile.experience.target_seniority_floor).toBe("mid; senior; c_level");
  });

  it("shows unsupported target values so they can be removed", async () => {
    const user = userEvent.setup();
    const initial = JSON.parse(JSON.stringify(sampleProfileResponse));
    initial.profile.experience = {
      target_track: "management; stealth",
      target_seniority_floor: "director; founder",
    };
    const updateProfile = vi.fn(async (request) => ({
      ...sampleProfileResponse,
      profile: JSON.parse(request.profileText),
    }));
    renderWithProviders(<ProfileForm initial={initial} section="target-search" />, {
      ports: buildTestPorts({ api: { updateProfile } }),
    });

    expect(screen.getByRole("button", { name: /stealth/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /founder/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /stealth/i }));
    await user.click(screen.getByRole("button", { name: /founder/i }));
    await user.click(screen.getByRole("button", { name: /^save changes$/i }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    const request = updateProfile.mock.calls[0]?.[0];
    const profile = JSON.parse(request.profileText);
    expect(profile.experience.target_track).toBe("management");
    expect(profile.experience.target_seniority_floor).toBe("director");
  });

  it("autosaves edited target search settings after five seconds", async () => {
    vi.useFakeTimers();
    const updateProfile = vi.fn(async (request) => ({
      ...sampleProfileResponse,
      profile: JSON.parse(request.profileText),
    }));
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} section="target-search" />, {
      ports: buildTestPorts({ api: { updateProfile } }),
    });

    fireEvent.change(screen.getByLabelText("Target roles 1"), {
      target: { value: "Director of Engineering" },
    });

    act(() => vi.advanceTimersByTime(4_999));
    expect(updateProfile).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });

    expect(updateProfile).toHaveBeenCalledTimes(1);
    const request = updateProfile.mock.calls[0]?.[0];
    expect(JSON.parse(request.profileText).experience.target_role).toBe("Director of Engineering");
  });

  it("keeps newer edits when an autosave response returns for an older snapshot", async () => {
    vi.useFakeTimers();
    let resolveUpdate: ((response: typeof sampleProfileResponse) => void) | undefined;
    const updateProfile = vi.fn(
      (request) =>
        new Promise<typeof sampleProfileResponse>((resolve) => {
          void request;
          resolveUpdate = resolve;
        }),
    );
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} section="target-search" />, {
      ports: buildTestPorts({ api: { updateProfile } }),
    });

    const targetRole = screen.getByLabelText("Target roles 1");
    fireEvent.change(targetRole, {
      target: { value: "Director of Engineering" },
    });

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(updateProfile).toHaveBeenCalledTimes(1);

    fireEvent.change(targetRole, {
      target: { value: "VP of Engineering" },
    });
    const request = updateProfile.mock.calls[0]?.[0];
    await act(async () => {
      resolveUpdate?.({
        ...sampleProfileResponse,
        profile: JSON.parse(request.profileText),
      });
      await Promise.resolve();
    });

    expect(targetRole).toHaveValue("VP of Engineering");
    expect(screen.getByText("Saved; newer changes pending")).toBeInTheDocument();
  });

  it("does not reset dirty edits when a saved autosave snapshot reaches the initial props", async () => {
    const initial = JSON.parse(JSON.stringify(sampleProfileResponse));
    initial.profile.experience = { target_role: "Director of Engineering" };
    const { rerender } = renderWithProviders(<ProfileForm initial={initial} section="target-search" />);

    const targetRole = screen.getByLabelText("Target roles 1");
    fireEvent.change(targetRole, {
      target: { value: "VP of Engineering" },
    });
    const autosavedInitial = JSON.parse(JSON.stringify(sampleProfileResponse));
    autosavedInitial.profile.experience = { target_role: "Director of Engineering" };

    rerender(<ProfileForm initial={autosavedInitial} section="target-search" />);

    expect(targetRole).toHaveValue("VP of Engineering");
  });

  it("undos target search checkbox changes with the keyboard shortcut", async () => {
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} section="target-search" />);

    const management = screen.getByRole("checkbox", { name: "Management" });
    fireEvent.click(management);
    await waitFor(() => expect(management).toBeChecked());

    fireEvent.keyDown(management, { key: "z", ctrlKey: true });

    await waitFor(() => expect(management).not.toBeChecked());
  });

  it("adds and focuses the next target role with Enter", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} section="target-search" />);

    await user.type(await screen.findByLabelText("Target roles 1"), "Director{Enter}");

    expect(screen.getByLabelText("Target roles 2")).toHaveFocus();
  });

  it("preserves spaces while editing target roles", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} section="target-search" />);

    const input = await screen.findByLabelText("Target roles 1");
    await user.type(input, "Director of Engineering");

    expect(input).toHaveValue("Director of Engineering");
  });

  it("adds and focuses the next target location with Enter", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} section="target-search" />);

    await user.type(await screen.findByLabelText("Target location 1"), "Barcelona{Enter}");

    expect(screen.getByLabelText("Target location 2")).toHaveFocus();
    expect(screen.getByRole("group", { name: "Target work model 2" })).toBeInTheDocument();
  });

  it("allows multiple work models for a target location", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} section="target-search" />);

    await user.click(await screen.findByRole("checkbox", { name: "Remote" }));
    await user.click(screen.getByRole("checkbox", { name: "Hybrid" }));

    expect(screen.getByRole("checkbox", { name: "Remote" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Hybrid" })).toBeChecked();
  });

  it("saves edited compensation number fields as profile strings", async () => {
    const user = userEvent.setup();
    const updateProfile = vi.fn(async (request) => ({
      ...sampleProfileResponse,
      profile: JSON.parse(request.profileText),
    }));
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} section="preferences" />, {
      ports: buildTestPorts({ api: { updateProfile } }),
    });

    const salaryRangeMin = await screen.findByLabelText("Salary range min");
    await user.clear(salaryRangeMin);
    await user.type(salaryRangeMin, "165001");
    expect(salaryRangeMin).toBeValid();
    await user.click(screen.getByRole("button", { name: /^save changes$/i }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    const request = updateProfile.mock.calls[0]?.[0];
    expect(JSON.parse(request.profileText).compensation.salary_range_min).toBe("165001");
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
