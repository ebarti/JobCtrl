import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ProfileSchema } from "@jobctrl/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  sampleProfileResponse,
} from "../../../test/fixtures/projections.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { renderWithProviders } from "../../../test/render.js";
import {
  ProfileForm,
  type ProfilePlateTextChange,
  type ProfilePlateTextController,
} from "./profile-form.js";

async function openExperienceEntries(user: ReturnType<typeof userEvent.setup>) {
  const disclosure = await screen.findByRole("button", {
    name: /^Experience entries\b/i,
  });
  if (disclosure.getAttribute("aria-expanded") === "false") {
    await user.click(disclosure);
  }
}

async function renderSkillProjection(items: string[]) {
  const user = userEvent.setup();
  const initial = structuredClone(sampleProfileResponse);
  const profile = ProfileSchema.parse(initial.profile);
  profile.resume.skill_categories = [{ id: "skill-1", label: "Languages", items }];
  initial.profile = profile;
  let controller: ProfilePlateTextController | null = null;
  const updateProfile = vi.fn(async (request) => ({ ...initial, profile: JSON.parse(request.profileText) }));
  renderWithProviders(<ProfileForm initial={initial} onPlateTextControllerChange={(value) => { controller = value; }} />,
    { ports: buildTestPorts({ api: { updateProfile } }), withRouter: true });
  const disclosure = await screen.findByRole("button", { name: /^Skill categories\b/ });
  if (disclosure.getAttribute("aria-expanded") === "false") await user.click(disclosure);
  await waitFor(() => expect(controller).not.toBeNull());
  return {
    user,
    updateProfile,
    applyChanges: (changes: readonly ProfilePlateTextChange[]) => act(() => controller?.apply(changes)),
    apply: (text: string | null) => act(() => controller?.apply(text === null ? [] : [{
      semanticId: "skills:skill-1:item:2", baselineTexts: ["JavaScript"], plateTexts: [text],
    }])),
  };
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

  it("keeps save and discard actions quiet until the form is dirty", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} />, {
      withRouter: true,
    });

    expect(await screen.findByRole("link", { name: "Import resume" })).toHaveAttribute(
      "data-slot",
      "button",
    );
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard changes" })).not.toBeInTheDocument();
    expect(screen.queryByText("No unsaved changes")).not.toBeInTheDocument();

    const fullName = screen.getByLabelText("Full name");
    const initialFullName = (fullName as HTMLInputElement).value;
    await user.clear(fullName);
    await user.type(fullName, "Updated Candidate");

    const save = screen.getByRole("button", { name: "Save changes" });
    const discard = screen.getByRole("button", { name: "Discard changes" });
    expect(save).toHaveAttribute("data-slot", "button");
    expect(save).toBeEnabled();
    expect(discard).toBeEnabled();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    await user.click(discard);

    expect(fullName).toHaveValue(initialFullName);
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
  });

  it("merges a Plate delta without reverting unrelated boxed Profile edits", async () => {
    const user = userEvent.setup();
    let plateController: ProfilePlateTextController | null = null;
    renderWithProviders(
      <ProfileForm
        initial={sampleProfileResponse}
        onPlateTextControllerChange={(controller) => {
          plateController = controller;
        }}
      />,
      { withRouter: true },
    );

    const fullName = await screen.findByLabelText("Full name");
    await user.clear(fullName);
    await user.type(fullName, "Boxed Profile Name");
    await waitFor(() => expect(plateController).not.toBeNull());
    act(() => {
      plateController?.apply([
        {
          semanticId: "experience:exp-1:bullet:1",
          baselineTexts: ["Scaled the platform 10x."],
          plateTexts: ["Scaled the platform 11x.", "Added from Plate."],
        },
      ]);
    });

    await openExperienceEntries(user);
    expect(screen.getByLabelText("Full name")).toHaveValue("Boxed Profile Name");
    expect(screen.getByLabelText("Bullet 1")).toHaveValue("Scaled the platform 11x.");
    expect(screen.getByLabelText("Bullet 2")).toHaveValue("Added from Plate.");
    expect(screen.getByLabelText("Bullet 3")).toHaveValue("Led the SRE org.");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    act(() => {
      plateController?.apply([]);
    });
    expect(screen.getByLabelText("Full name")).toHaveValue("Boxed Profile Name");
    expect(screen.getByLabelText("Bullet 1")).toHaveValue("Scaled the platform 10x.");
    expect(screen.getByLabelText("Bullet 2")).toHaveValue("Led the SRE org.");
  });

  it("serializes only edited fields while preserving unknown nested data through Plate projection", async () => {
    const user = userEvent.setup();
    const initial = structuredClone(sampleProfileResponse);
    const profile = initial.profile as Record<string, unknown>;
    profile["futureProfile"] = { nested: ["keep", { flag: true }] };
    const resume = profile["resume"] as Record<string, unknown>;
    const rules = resume["tailoring_rules"] as Record<string, unknown>;
    rules["max_bullets_per_role"] = "07";
    const entries = resume["experience_entries"] as Array<Record<string, unknown>>;
    entries[0]!["futureEntry"] = { source: "synthetic-preserved" };
    initial.style = { ...(initial.style as Record<string, unknown>), futureStyle: { nested: [3, 1] } };
    const original = structuredClone(initial);
    let plateController: ProfilePlateTextController | null = null;
    const updateProfile = vi.fn(async (request) => ({
      ...initial, profile: JSON.parse(request.profileText), style: JSON.parse(request.styleText),
    }));
    renderWithProviders(<ProfileForm initial={initial} onPlateTextControllerChange={(controller) => {
      plateController = controller;
    }} />, { ports: buildTestPorts({ api: { updateProfile } }), withRouter: true });

    fireEvent.change(await screen.findByLabelText("Full name"), { target: { value: "Boxed synthetic name" } });
    act(() => plateController?.apply([{
      semanticId: "experience:exp-1:bullet:1", baselineTexts: ["Scaled the platform 10x."],
      plateTexts: ["Scaled the platform 12x.", "Second synthetic bullet."],
    }]));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    const request = updateProfile.mock.calls[0]![0];
    expect(Object.keys(request).sort()).toEqual(["profileText", "styleText", "templateText"]);
    const expected = structuredClone(original.profile) as Record<string, unknown>;
    (expected["personal"] as Record<string, unknown>)["full_name"] = "Boxed synthetic name";
    const expectedEntries = (expected["resume"] as Record<string, unknown>)["experience_entries"] as Array<Record<string, unknown>>;
    expectedEntries[0]!["bullets"] = ["Scaled the platform 12x.", "Second synthetic bullet.", "Led the SRE org."];
    expect(JSON.parse(request.profileText)).toEqual(expected);
    expect(JSON.parse(request.styleText)).toEqual(original.style);
    expect(request.templateText).toEqual(original.templateText);
    expect(initial).toEqual(original);
  });

  it("preserves and surfaces a structural Profile conflict instead of overwriting it from Plate", async () => {
    const user = userEvent.setup();
    let plateController: ProfilePlateTextController | null = null;
    renderWithProviders(
      <ProfileForm
        initial={sampleProfileResponse}
        onPlateTextControllerChange={(controller) => {
          plateController = controller;
        }}
      />,
      { withRouter: true },
    );

    await openExperienceEntries(user);
    await user.click(screen.getByRole("button", { name: "Remove bullet 1" }));
    expect(screen.getByLabelText("Bullet 1")).toHaveValue("Led the SRE org.");
    await waitFor(() => expect(plateController).not.toBeNull());
    act(() => {
      plateController?.apply([
        {
          semanticId: "experience:exp-1:bullet:1",
          baselineTexts: ["Scaled the platform 10x."],
          plateTexts: ["Scaled the platform 11x."],
        },
      ]);
    });

    expect(screen.getByLabelText("Bullet 1")).toHaveValue("Led the SRE org.");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Some resume editor changes were not applied because the matching Profile data changed.",
    );
  });

  it("saves the fifth role's title and every mapped scalar field by identity, preserving unrelated data", async () => {
    const user = userEvent.setup();
    const initial = structuredClone(sampleProfileResponse);
    const profile = ProfileSchema.parse(initial.profile);
    profile.resume.experience_entries = Array.from({ length: 5 }, (_, index) => ({
      id: `role-${index + 1}`, title: `Role ${index + 1}`, company: "Fixture", location: "Remote",
      date_range: "Jan 2020 - Present", summary: "Original summary", bullets: [`Evidence ${index + 1}`], achievement_evidence: [],
    }));
    profile.resume.education_entries = [{ id: "edu-1", degree: "BSc", institution: "Old University", location: "Old City", date: "2019" }];
    profile.resume.skill_categories = [{ id: "skill-1", label: "Tools", items: ["CI, CD", "Java"] }];
    initial.profile = { ...profile, futureData: { keep: ["unchanged"] } };
    let controller: ProfilePlateTextController | null = null;
    const updateProfile = vi.fn(async (request) => ({ ...initial, profile: JSON.parse(request.profileText) }));
    renderWithProviders(<ProfileForm initial={initial} onPlateTextControllerChange={(value) => { controller = value; }} />,
      { ports: buildTestPorts({ api: { updateProfile } }), withRouter: true });
    await openExperienceEntries(user);
    await user.click(screen.getByRole("button", { name: "Move Fixture - Role 5 up" }));
    const changes = [
      ["experience:role-5:title", "Role 5", "Principal Engineer"],
      ["experience:role-5:company", "Fixture", "New Company"],
      ["experience:role-5:location", "Remote", "New City | Hybrid"],
      ["experience:role-5:date_range", "Jan 2020 - Present", "Feb 2021 - Dec 2025"],
      ["education:edu-1:degree", "BSc", "MSc"], ["education:edu-1:institution", "Old University", "New University"],
      ["education:edu-1:location", "Old City", "New City"], ["education:edu-1:date", "2019", "2021"],
      ["skills:skill-1:label", "Tools", "Languages"], ["skills:skill-1:item:1", "CI, CD", "Build, Release"],
      ["personal:city", profile.personal.city ?? "", "Profile City"],
      ["personal:phone", profile.personal.phone ?? "", "+44 1234 567890"],
    ].map(([semanticId, baseline, desired]) => ({ semanticId: semanticId!, baselineTexts: [baseline!], plateTexts: [desired!] }));
    act(() => controller?.apply(changes));
    expect(screen.getAllByLabelText("Title", { exact: true })[3]).toHaveValue("Principal Engineer");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    const saved = JSON.parse(updateProfile.mock.calls[0]![0].profileText);
    expect(saved.resume.experience_entries.map((entry: { id: string }) => entry.id)).toEqual(["role-1", "role-2", "role-3", "role-5", "role-4"]);
    expect(saved.resume.experience_entries[3]).toMatchObject({ id: "role-5", title: "Principal Engineer", company: "New Company", location: "New City | Hybrid", date_range: "Feb 2021 - Dec 2025", bullets: ["Evidence 5"] });
    expect(saved.resume.experience_entries[4]).toEqual(profile.resume.experience_entries[3]);
    expect(saved.resume.education_entries[0]).toEqual({ id: "edu-1", degree: "MSc", institution: "New University", location: "New City", date: "2021" });
    expect(saved.resume.skill_categories[0]).toEqual({ id: "skill-1", label: "Languages", items: ["Build, Release", "Java"] });
    expect(saved.personal).toMatchObject({ city: "Profile City", phone: "+44 1234 567890" });
    expect(saved.futureData).toEqual({ keep: ["unchanged"] });
  });

  it("keeps projecting and saving a skill through a duplicate sibling value, including undo", async () => {
    const { user, updateProfile, apply } = await renderSkillProjection(["Java", "JavaScript"]);
    for (const text of ["Java", "Java ", "Java X"]) {
      apply(text);
      expect(screen.getByLabelText("Skill 1")).toHaveValue("Java");
      expect(screen.getByLabelText("Skill 2")).toHaveValue(text.trim());
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    }
    apply(null);
    expect(screen.getByLabelText("Skill 2")).toHaveValue("JavaScript");
    apply("Java");
    apply("Java X");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    expect(JSON.parse(updateProfile.mock.calls[0]![0].profileText).resume.skill_categories[0].items)
      .toEqual(["Java", "Java X"]);
  });

  it("preserves a boxed skill edit instead of moving the Plate edit to its duplicate sibling", async () => {
    const { user, updateProfile, apply } = await renderSkillProjection(["Java", "JavaScript"]);
    apply("Java");
    fireEvent.change(screen.getByLabelText("Skill 2"), { target: { value: "Kotlin" } });
    apply("Java X");
    expect(screen.getByLabelText("Skill 1")).toHaveValue("Java");
    expect(screen.getByLabelText("Skill 2")).toHaveValue("Kotlin");
    expect(screen.getByRole("alert")).toHaveTextContent("Some resume editor changes were not applied");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    expect(JSON.parse(updateProfile.mock.calls[0]![0].profileText).resume.skill_categories[0].items)
      .toEqual(["Java", "Kotlin"]);
  });

  it.each([false, true])("keeps duplicate skill tracking across sibling preview edits (reversed: %s)", async (reversed) => {
    const { apply, applyChanges } = await renderSkillProjection(["Java", "JavaScript", "Python"]);
    apply("Java");
    for (const [java, python] of [["Java", "Python X"], ["Java", "Python XY"], ["Java X", "Python XY"]]) {
      const changes = [
        { semanticId: "skills:skill-1:item:2", baselineTexts: ["JavaScript"], plateTexts: [java!] },
        { semanticId: "skills:skill-1:item:3", baselineTexts: ["Python"], plateTexts: [python!] },
      ];
      applyChanges(reversed ? changes.reverse() : changes);
      expect(screen.getByLabelText("Skill 1")).toHaveValue("Java");
      expect(screen.getByLabelText("Skill 2")).toHaveValue(java);
      expect(screen.getByLabelText("Skill 3")).toHaveValue(python);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    }
  });

  it("follows an unambiguous skill when removing an earlier sibling changes its index", async () => {
    const { user, apply } = await renderSkillProjection(["Java", "JavaScript", "Python"]);
    apply("JavaScript X");
    await user.click(screen.getByRole("button", { name: "Remove skill 1" }));
    apply("JavaScript XY");
    expect(screen.getByLabelText("Skill 1")).toHaveValue("JavaScript XY");
    expect(screen.getByLabelText("Skill 2")).toHaveValue("Python");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("preserves the trailing duplicate when the edited skill is removed", async () => {
    const { user, apply } = await renderSkillProjection(["Java", "JavaScript", "Java"]);
    apply("Java");
    await user.click(screen.getByRole("button", { name: "Remove skill 2" }));
    apply("Java X");
    expect(screen.getByLabelText("Skill 1")).toHaveValue("Java");
    expect(screen.getByLabelText("Skill 2")).toHaveValue("Java");
    expect(screen.getByRole("alert")).toHaveTextContent("Some resume editor changes were not applied");
  });

  it("preserves duplicate siblings when the edited skill is removed and another is added", async () => {
    const { user, apply } = await renderSkillProjection(["Java", "JavaScript", "Java"]);
    apply("Java");
    await user.click(screen.getByRole("button", { name: "Remove skill 2" }));
    await user.click(screen.getByRole("button", { name: "Add skill" }));
    fireEvent.change(screen.getByLabelText("Skill 3"), { target: { value: "Python" } });
    apply("Java X");
    expect(screen.getByLabelText("Skill 1")).toHaveValue("Java");
    expect(screen.getByLabelText("Skill 2")).toHaveValue("Java");
    expect(screen.getByLabelText("Skill 3")).toHaveValue("Python");
    expect(screen.getByRole("alert")).toHaveTextContent("Some resume editor changes were not applied");
  });

  it.each(["unmapped:education:edu-1:details", "unmapped:personal:full_name"])(
    "directs an unmapped preview edit to Profile data without blaming a conflicting edit: %s",
    async (semanticId) => {
      let controller: ProfilePlateTextController | null = null;
      renderWithProviders(<ProfileForm initial={sampleProfileResponse} onPlateTextControllerChange={(value) => { controller = value; }} />,
        { withRouter: true });
      const fullName = await screen.findByLabelText("Full name");
      const originalName = (fullName as HTMLInputElement).value;
      await waitFor(() => expect(controller).not.toBeNull());
      act(() => controller?.apply([{ semanticId, baselineTexts: ["Preview text"], plateTexts: ["Edited preview text"] }]));
      expect(screen.getByRole("alert")).toHaveTextContent("Some parts of the preview cannot be edited here. Edit those fields in Profile data instead.");
      expect(screen.getByRole("alert")).not.toHaveTextContent("Profile data changed");
      expect(fullName).toHaveValue(originalName);
      expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    },
  );

  it("undoes a title edit, including deletion, but preserves a newer boxed title as a conflict", async () => {
    const user = userEvent.setup();
    let controller: ProfilePlateTextController | null = null;
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} onPlateTextControllerChange={(value) => { controller = value; }} />, { withRouter: true });
    await openExperienceEntries(user);
    const title = screen.getByLabelText("Title", { exact: true });
    const original = (title as HTMLInputElement).value;
    const change = { semanticId: "experience:exp-1:title", baselineTexts: [original], plateTexts: [""] };
    act(() => controller?.apply([change]));
    expect(title).toHaveValue("");
    act(() => controller?.apply([]));
    expect(title).toHaveValue(original);
    fireEvent.change(title, { target: { value: "Newer boxed title" } });
    act(() => controller?.apply([{ ...change, plateTexts: ["Conflicting Plate title"] }]));
    expect(title).toHaveValue("Newer boxed title");
    expect(screen.getByRole("alert")).toHaveTextContent("Some resume editor changes were not applied");
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
    for (const cardTitle of [
      "Target tracks",
      "Seniority floors",
      "Role areas",
      "Locations and work models",
    ]) {
      const card = screen.getByRole("region", { name: cardTitle });
      expect(card).toHaveAttribute("data-slot", "card");
      expect(
        within(card).getByText(cardTitle, { selector: '[data-slot="card-title"]' }),
      ).toHaveAttribute(
        "data-typography",
        "component-title",
      );
    }
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
    expect(screen.getByRole("group", { name: "Target work model 1" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Remote" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Hybrid" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Application configuration" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Personal information" })).not.toBeInTheDocument();
  });

  it("does not add a legacy form-section shell when the Discovery heading is hidden", () => {
    const { container } = renderWithProviders(
      <ProfileForm
        initial={sampleProfileResponse}
        section="target-search"
        showSectionHeading={false}
      />,
    );

    const targetGrid = container.querySelector(".target-preferences-grid");
    expect(targetGrid?.parentElement).toHaveClass("target-search-grid-shell");
    expect(targetGrid?.parentElement).not.toHaveClass("form-section");
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
    const onPreviewSourceChange = vi.fn();
    let resolveUpdate: ((response: typeof sampleProfileResponse) => void) | undefined;
    const updateProfile = vi.fn(
      (request) =>
        new Promise<typeof sampleProfileResponse>((resolve) => {
          void request;
          resolveUpdate = resolve;
        }),
    );
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} section="target-search" onPreviewSourceChange={onPreviewSourceChange} />, {
      ports: buildTestPorts({ api: { updateProfile } }),
    });
    expect(onPreviewSourceChange).toHaveBeenCalledTimes(1);

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
    expect(onPreviewSourceChange).toHaveBeenCalledTimes(1);
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
