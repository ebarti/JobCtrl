import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sampleProfileResponse } from "../../../test/fixtures/projections.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { renderWithProviders } from "../../../test/render.js";
import { ProfileForm } from "./profile-form.js";

describe("<ProfileForm>", () => {
  afterEach(() => {
    vi.useRealTimers();
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
    expect(screen.getByRole("heading", { name: "Tailoring controls" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Target search" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Target tracks" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Personal information" })).not.toBeInTheDocument();
  });

  it("renders target search as a discovery settings section", async () => {
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} section="target-search" />);

    expect(screen.getByRole("heading", { name: "Target search" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Target tracks" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Individual Contributor" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Management" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Executive" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Seniority floors" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Junior Engineer" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Senior Engineering Manager / Head of Engineering" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "CTO" })).toBeInTheDocument();
    expect(screen.getByLabelText("Role areas 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Role areas 1")).toHaveAttribute("placeholder", "Engineering, security, platform");
    expect(screen.getByLabelText("Specializations 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Target roles 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Target location 1")).toBeInTheDocument();
    expect(screen.getByText("Locations and work models")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Target work model 1" })).toBeInTheDocument();
    expect(screen.getByLabelText("Remote")).toBeInTheDocument();
    expect(screen.getByLabelText("Hybrid")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Application defaults" })).not.toBeInTheDocument();
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
    await user.click(screen.getByRole("checkbox", { name: "Senior Engineering Manager / Head of Engineering" }));
    await user.click(screen.getByRole("checkbox", { name: "CTO" }));
    await user.click(screen.getByRole("button", { name: /^save discovery settings$/i }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    const request = updateProfile.mock.calls[0]?.[0];
    const profile = JSON.parse(request.profileText);
    expect(profile.experience.target_track).toBe("management; executive");
    expect(profile.experience.target_seniority_floor).toBe("senior_manager; cto");
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
    await user.click(screen.getByRole("button", { name: /^save discovery settings$/i }));

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
    expect(screen.getByText("saved; newer changes pending")).toBeInTheDocument();
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

    await user.click(await screen.findByLabelText("Remote"));
    await user.click(screen.getByLabelText("Hybrid"));

    expect(screen.getByLabelText("Remote")).toBeChecked();
    expect(screen.getByLabelText("Hybrid")).toBeChecked();
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
    await user.click(screen.getByRole("button", { name: /^save all$/i }));

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
