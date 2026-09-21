import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import {
  ProfileSchema,
  type ProfileShape,
  type TargetRoleSuggestionResponse,
} from "@jobctrl/contracts";
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

  it("keeps a moved bullet's Plate edits on the same source when saving the reordered profile", async () => {
    const user = userEvent.setup();
    let controller: ProfilePlateTextController | null = null;
    const updateProfile = vi.fn(async (request) => ({
      ...sampleProfileResponse, profile: JSON.parse(request.profileText),
    }));
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} onPlateTextControllerChange={(value) => {
      controller = value;
    }} />, { ports: buildTestPorts({ api: { updateProfile } }), withRouter: true });
    await openExperienceEntries(user);
    await user.click(screen.getByRole("button", { name: "Move bullet 1 down" }));
    expect(screen.getByLabelText("Bullet 1")).toHaveValue("Led the SRE org.");
    expect(screen.getByLabelText("Bullet 2")).toHaveValue("Scaled the platform 10x.");
    act(() => controller?.apply([{
      semanticId: "experience:exp-1:bullet:1",
      baselineTexts: ["Scaled the platform 10x."],
      plateTexts: ["Scaled the platform 12x."],
    }]));
    expect(screen.getByLabelText("Bullet 1")).toHaveValue("Led the SRE org.");
    expect(screen.getByLabelText("Bullet 2")).toHaveValue("Scaled the platform 12x.");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    expect(JSON.parse(updateProfile.mock.calls[0]![0].profileText).resume.experience_entries[0].bullets)
      .toEqual(["Led the SRE org.", "Scaled the platform 12x."]);
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

  it("discards later edits to the last persisted save after fresh initial props arrive", async () => {
    const user = userEvent.setup();
    const updateProfile = vi.fn(async (request) => ({
      ...sampleProfileResponse,
      profile: JSON.parse(request.profileText),
    }));
    const { rerender } = renderWithProviders(
      <ProfileForm initial={sampleProfileResponse} section="target-search" />,
      { ports: buildTestPorts({ api: { updateProfile } }) },
    );

    const targetRole = screen.getByLabelText("Target roles 1");
    fireEvent.change(targetRole, { target: { value: "Director of Engineering" } });
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    const request = updateProfile.mock.calls[0]![0];
    expect(JSON.parse(request.profileText).experience.target_role).toBe("Director of Engineering");
    const savedResponse = await updateProfile.mock.results[0]!.value;
    expect(await screen.findByText("Discovery settings saved")).toBeInTheDocument();
    rerender(<ProfileForm initial={savedResponse} section="target-search" />);

    expect(targetRole).toHaveValue("Director of Engineering");
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard changes" })).not.toBeInTheDocument();
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();

    fireEvent.change(targetRole, { target: { value: "VP of Engineering" } });
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Discard changes" })).toBeEnabled();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Discard changes" }));

    expect(targetRole).toHaveValue("Director of Engineering");
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard changes" })).not.toBeInTheDocument();
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    expect(updateProfile).toHaveBeenCalledTimes(1);
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

  it("keeps newer edits on a late autosave response and discards them to the persisted snapshot", async () => {
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
    const { rerender } = renderWithProviders(<ProfileForm initial={sampleProfileResponse} section="target-search" onPreviewSourceChange={onPreviewSourceChange} />, {
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
    expect(JSON.parse(request.profileText).experience.target_role).toBe("Director of Engineering");
    const savedResponse = {
      ...sampleProfileResponse,
      profile: JSON.parse(request.profileText),
    };
    await act(async () => {
      resolveUpdate?.(savedResponse);
      await Promise.resolve();
    });

    expect(targetRole).toHaveValue("VP of Engineering");
    expect(screen.getByText("Saved; newer changes pending")).toBeInTheDocument();
    expect(onPreviewSourceChange).toHaveBeenCalledTimes(1);

    rerender(<ProfileForm initial={savedResponse} section="target-search" onPreviewSourceChange={onPreviewSourceChange} />);

    expect(targetRole).toHaveValue("VP of Engineering");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Discard changes" })).toBeEnabled();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(onPreviewSourceChange).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));

    expect(targetRole).toHaveValue("Director of Engineering");
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard changes" })).not.toBeInTheDocument();
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    expect(screen.queryByText("Saved; newer changes pending")).not.toBeInTheDocument();
    expect(onPreviewSourceChange).toHaveBeenLastCalledWith(savedResponse);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(updateProfile).toHaveBeenCalledTimes(1);
  });

  it("keeps a second autosave version-agnostic after a late manual-save response", async () => {
    vi.useFakeTimers();
    let resolveFirstSave: ((response: typeof sampleProfileResponse) => void) | undefined;
    const updateProfile = vi.fn()
      .mockImplementationOnce((request) => new Promise<typeof sampleProfileResponse>((resolve) => {
        resolveFirstSave = (response) => resolve({
          ...response,
          profile: JSON.parse(request.profileText),
        });
      }))
      .mockImplementationOnce(async (request) => ({
        ...sampleProfileResponse,
        profileVersion: 5,
        profile: JSON.parse(request.profileText),
      }));
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} section="target-search" />, {
      ports: buildTestPorts({ api: { updateProfile } }),
    });

    const targetRole = screen.getByLabelText("Target roles 1");
    fireEvent.change(targetRole, { target: { value: "Director of Engineering" } });
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(updateProfile).toHaveBeenCalledTimes(1);
    expect(updateProfile.mock.calls[0]![0]).not.toHaveProperty("expectedProfileVersion");

    fireEvent.change(targetRole, { target: { value: "VP of Engineering" } });
    await act(async () => {
      resolveFirstSave?.({ ...sampleProfileResponse, profileVersion: 4 });
      await Promise.resolve();
    });
    expect(screen.getByText("Saved; newer changes pending")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(updateProfile).toHaveBeenCalledTimes(2);
    expect(updateProfile.mock.calls[1]![0]).not.toHaveProperty("expectedProfileVersion");
    expect(JSON.parse(updateProfile.mock.calls[1]![0].profileText).experience.target_role).toBe(
      "VP of Engineering",
    );
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

  it("appends and dedupes delayed suggestions against intervening form edits", async () => {
    const user = userEvent.setup();
    let resolveSuggestions: ((response: TargetRoleSuggestionResponse) => void) | undefined;
    const targetRoleSuggestions = vi.fn(() => new Promise<TargetRoleSuggestionResponse>((resolve) => {
      resolveSuggestions = resolve;
    }));
    const updateProfile = vi.fn(async (request) => ({
      ...sampleProfileResponse,
      profileVersion: 4,
      profile: JSON.parse(request.profileText),
    }));
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} section="target-search" />, {
      ports: buildTestPorts({ api: { targetRoleSuggestions, updateProfile } }),
    });

    await user.click(screen.getByRole("button", { name: "Suggest roles" }));
    expect(targetRoleSuggestions).toHaveBeenCalledWith({
      expectedProfileVersion: 3,
      maximumSuggestions: 3,
    });
    await user.type(screen.getByLabelText("Target roles 1"), "VP Engineering");
    await act(async () => {
      resolveSuggestions?.({
        ok: true,
        profileVersion: 3,
        suggestions: [
          {
            title: "vp engineering",
            classification: "direct",
            track: "Management",
            seniority: "VP",
            evidenceIds: ["experience:exp-1"],
            rationale: "Matches the saved role evidence.",
          },
          {
            title: "Head of Platform",
            classification: "adjacent",
            track: "Management",
            seniority: "Director",
            evidenceIds: ["experience:exp-1", "exp-1_bullet_1"],
            rationale: "Saved delivery evidence supports adjacent scope.",
          },
        ],
        strategy: "model",
        warnings: [],
      });
      await Promise.resolve();
    });
    await user.click(await screen.findByRole("button", { name: "Add selected roles" }));

    expect(screen.getByLabelText("Target roles 1")).toHaveValue("VP Engineering");
    expect(screen.getByLabelText("Target roles 2")).toHaveValue("Head of Platform");
    expect(screen.queryByLabelText("Target roles 3")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    const request = updateProfile.mock.calls[0]![0];
    expect(request.expectedProfileVersion).toBe(3);
    expect(JSON.parse(request.profileText).experience.target_role).toBe(
      "VP Engineering; Head of Platform",
    );
  });

  it("keeps later manual edits version-agnostic after a delayed guarded suggestion save", async () => {
    const user = userEvent.setup();
    let resolveFirstSave: ((response: typeof sampleProfileResponse) => void) | undefined;
    const targetRoleSuggestions = vi.fn(async () => ({
      ok: true as const,
      profileVersion: 3,
      suggestions: [
        {
          title: "Head of Platform",
          classification: "adjacent" as const,
          track: "Management",
          seniority: "Director",
          evidenceIds: ["experience:exp-1", "exp-1_bullet_1"],
          rationale: "Saved delivery evidence supports adjacent scope.",
        },
      ],
      strategy: "model" as const,
      warnings: ["stubbed_model_evidence"],
    }));
    const updateProfile = vi.fn()
      .mockImplementationOnce((request) => new Promise<typeof sampleProfileResponse>((resolve) => {
        resolveFirstSave = (response) => resolve({
          ...response,
          profile: JSON.parse(request.profileText),
        });
      }))
      .mockImplementationOnce(async (request) => ({
        ...sampleProfileResponse,
        profileVersion: 5,
        profile: JSON.parse(request.profileText),
      }));
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} section="target-search" />, {
      ports: buildTestPorts({ api: { targetRoleSuggestions, updateProfile } }),
    });

    await user.click(screen.getByRole("button", { name: "Suggest roles" }));
    await user.click(await screen.findByRole("button", { name: "Add selected roles" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    expect(updateProfile.mock.calls[0]![0].expectedProfileVersion).toBe(3);

    fireEvent.change(screen.getByLabelText("Target location 1"), {
      target: { value: "Madrid" },
    });
    await act(async () => {
      resolveFirstSave?.({ ...sampleProfileResponse, profileVersion: 4 });
      await Promise.resolve();
    });
    expect(screen.getByText("Saved; newer changes pending")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(2));
    const retry = updateProfile.mock.calls[1]![0];
    expect(retry).not.toHaveProperty("expectedProfileVersion");
    expect(JSON.parse(retry.profileText).experience).toMatchObject({
      target_role: "Head of Platform",
      target_locations: "Madrid",
    });
  });

  it("keeps a suggestion accepted during an earlier guarded save version-guarded", async () => {
    const user = userEvent.setup();
    let resolveFirstSave: ((response: typeof sampleProfileResponse) => void) | undefined;
    const suggestion = (title: string, profileVersion: number): TargetRoleSuggestionResponse => ({
      ok: true,
      profileVersion,
      suggestions: [
        {
          title,
          classification: "adjacent",
          track: "Management",
          seniority: "Director",
          evidenceIds: ["experience:exp-1", "exp-1_bullet_1"],
          rationale: "Saved delivery evidence supports adjacent scope.",
        },
      ],
      strategy: "model",
      warnings: ["stubbed_model_evidence"],
    });
    const targetRoleSuggestions = vi.fn()
      .mockResolvedValueOnce(suggestion("Head of Platform", 3))
      .mockResolvedValueOnce(suggestion("Director of Infrastructure", 3))
      .mockResolvedValueOnce(suggestion("Director of Infrastructure", 4));
    const updateProfile = vi.fn()
      .mockImplementationOnce((request) => new Promise<typeof sampleProfileResponse>((resolve) => {
        resolveFirstSave = (response) => resolve({
          ...response,
          profile: JSON.parse(request.profileText),
        });
      }))
      .mockImplementationOnce(async (request) => ({
        ...sampleProfileResponse,
        profileVersion: 5,
        profile: JSON.parse(request.profileText),
      }));
    const ports = buildTestPorts({ api: { targetRoleSuggestions, updateProfile } });
    const { rerender } = renderWithProviders(
      <ProfileForm initial={sampleProfileResponse} section="target-search" />,
      { ports },
    );

    await user.click(screen.getByRole("button", { name: "Suggest roles" }));
    await user.click(await screen.findByRole("button", { name: "Add selected roles" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "Suggest roles" }));
    await user.click(await screen.findByRole("button", { name: "Add selected roles" }));
    const savedA = { ...sampleProfileResponse, profileVersion: 4 };
    await act(async () => {
      resolveFirstSave?.(savedA);
      await Promise.resolve();
    });
    rerender(<ProfileForm initial={{
      ...savedA,
      profile: JSON.parse(updateProfile.mock.calls[0]![0].profileText),
    }} section="target-search" />);

    expect(screen.getByDisplayValue("Head of Platform")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Director of Infrastructure")).not.toBeInTheDocument();
    expect(screen.getByText(/Stale suggested roles were removed/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(updateProfile).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/regenerate suggestions, and review them before saving/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Suggest roles" }));
    await user.click(await screen.findByRole("button", { name: "Add selected roles" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(2));
    const saveB = updateProfile.mock.calls[1]![0];
    expect(saveB.expectedProfileVersion).toBe(4);
    expect(JSON.parse(saveB.profileText).experience.target_role).toBe(
      "Head of Platform; Director of Infrastructure",
    );
  });

  it("treats a form replacement of an accepted role as version-agnostic manual intent", async () => {
    const user = userEvent.setup();
    const targetRoleSuggestions = vi.fn(async () => ({
      ok: true as const,
      profileVersion: 3,
      suggestions: [
        {
          title: "Head of Platform",
          classification: "adjacent" as const,
          track: "Management",
          seniority: "Director",
          evidenceIds: ["experience:exp-1", "exp-1_bullet_1"],
          rationale: "Saved delivery evidence supports adjacent scope.",
        },
      ],
      strategy: "model" as const,
      warnings: ["stubbed_model_evidence"],
    }));
    const updateProfile = vi.fn(async (request) => ({
      ...sampleProfileResponse,
      profileVersion: 4,
      profile: JSON.parse(request.profileText),
    }));
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} section="target-search" />, {
      ports: buildTestPorts({ api: { targetRoleSuggestions, updateProfile } }),
    });

    await user.click(screen.getByRole("button", { name: "Suggest roles" }));
    await user.click(await screen.findByRole("button", { name: "Add selected roles" }));
    const acceptedRole = screen.getByLabelText("Target roles 1");
    await user.clear(acceptedRole);
    await user.type(acceptedRole, "Manual Architect");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));

    const request = updateProfile.mock.calls[0]![0];
    expect(request).not.toHaveProperty("expectedProfileVersion");
    expect(JSON.parse(request.profileText).experience.target_role).toBe("Manual Architect");
  });

  it("requires a conflict-aware rebase and regeneration after a stale suggestion save", async () => {
    const user = userEvent.setup();
    const initialV3 = structuredClone(sampleProfileResponse);
    initialV3.profileVersion = 3;
    initialV3.profile = ProfileSchema.parse(initialV3.profile);
    const initialV4 = structuredClone(initialV3);
    initialV4.profileVersion = 4;
    const canonicalV4Profile = initialV4.profile as ProfileShape;
    canonicalV4Profile.personal.full_name = "External Canonical Name";
    initialV4.profile = canonicalV4Profile;
    const targetRoleSuggestions = vi.fn(async ({ expectedProfileVersion }) => ({
      ok: true as const,
      profileVersion: expectedProfileVersion,
      suggestions: [
        {
          title: "Head of Platform",
          classification: "adjacent" as const,
          track: "Management",
          seniority: "Director",
          evidenceIds: ["experience:exp-1", "exp-1_bullet_1"],
          rationale: "Saved delivery evidence supports adjacent scope.",
        },
      ],
      strategy: "model" as const,
      warnings: ["stubbed_model_evidence"],
    }));
    const updateProfile = vi.fn()
      .mockRejectedValueOnce(new Error("The saved profile changed. Refresh and try again."))
      .mockImplementationOnce(async (request) => ({
        ...initialV4,
        profileVersion: 5,
        profile: JSON.parse(request.profileText),
      }));
    const ports = buildTestPorts({ api: { targetRoleSuggestions, updateProfile } });
    const { rerender } = renderWithProviders(
      <ProfileForm initial={initialV3} section="target-search" />,
      { ports },
    );

    await user.type(screen.getByLabelText("Target location 1"), "Madrid");
    await user.click(screen.getByRole("button", { name: "Suggest roles" }));
    await user.click(await screen.findByRole("button", { name: "Add selected roles" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("The saved profile changed. Refresh and try again.")).toBeInTheDocument();
    expect(updateProfile.mock.calls[0]![0].expectedProfileVersion).toBe(3);

    rerender(<ProfileForm initial={initialV4} section="target-search" />);

    const suggestRoles = screen.getByRole("button", { name: "Suggest roles" });
    expect(suggestRoles).toBeDisabled();
    expect(screen.getByText(/saved profile changed while this form has unsaved edits/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Rebase edits onto saved profile" }));
    await waitFor(() => expect(suggestRoles).toBeEnabled());
    expect(screen.getByText(/Draft rebased and stale suggested roles removed/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(updateProfile).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/regenerate suggestions, and review them before saving/i)).toBeInTheDocument();

    await user.click(suggestRoles);
    expect(targetRoleSuggestions).toHaveBeenLastCalledWith({
      expectedProfileVersion: 4,
      maximumSuggestions: 3,
    });
    await user.click(await screen.findByRole("button", { name: "Add selected roles" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(2));

    const retry = updateProfile.mock.calls[1]![0];
    expect(retry.expectedProfileVersion).toBe(4);
    expect(JSON.parse(retry.profileText)).toMatchObject({
      personal: { full_name: "External Canonical Name" },
      experience: { target_role: "Head of Platform", target_locations: "Madrid" },
    });
  });

  it("removes stale suggested roles before a zero-result review authorizes rebased manual edits", async () => {
    const user = userEvent.setup();
    const initialV3 = structuredClone(sampleProfileResponse);
    initialV3.profileVersion = 3;
    initialV3.profile = ProfileSchema.parse(initialV3.profile);
    const canonicalV3Profile = initialV3.profile as ProfileShape;
    canonicalV3Profile.experience.target_role = "VP Engineering";
    initialV3.profile = canonicalV3Profile;
    const initialV4 = structuredClone(initialV3);
    initialV4.profileVersion = 4;
    const canonicalV4Profile = initialV4.profile as ProfileShape;
    canonicalV4Profile.personal.full_name = "External Canonical Name";
    initialV4.profile = canonicalV4Profile;
    const targetRoleSuggestions = vi.fn()
      .mockResolvedValueOnce({
        ok: true as const,
        profileVersion: 3,
        suggestions: [
          {
            title: "Head of Platform",
            classification: "adjacent" as const,
            track: "Management",
            seniority: "Director",
            evidenceIds: ["experience:exp-1", "exp-1_bullet_1"],
            rationale: "Saved delivery evidence supports adjacent scope.",
          },
        ],
        strategy: "model" as const,
        warnings: ["stubbed_model_evidence"],
      })
      .mockResolvedValueOnce({
        ok: true as const,
        profileVersion: 4,
        suggestions: [],
        strategy: "none" as const,
        warnings: ["provider_token_or_cost_bound_unsupported"],
      });
    const updateProfile = vi.fn()
      .mockRejectedValueOnce(new Error("The saved profile changed. Refresh and try again."))
      .mockImplementationOnce(async (request) => ({
        ...initialV4,
        profileVersion: 5,
        profile: JSON.parse(request.profileText),
      }));
    const ports = buildTestPorts({ api: { targetRoleSuggestions, updateProfile } });
    const { rerender } = renderWithProviders(
      <ProfileForm initial={initialV3} section="target-search" />,
      { ports },
    );

    await user.type(screen.getByLabelText("Target location 1"), "Madrid");
    await user.click(screen.getByRole("button", { name: "Suggest roles" }));
    await user.click(await screen.findByRole("button", { name: "Add selected roles" }));
    expect(screen.getByDisplayValue("VP Engineering")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Head of Platform")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Target roles 2"), "{Enter}");
    await user.type(screen.getByLabelText("Target roles 3"), "Manual Architect");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("The saved profile changed. Refresh and try again.")).toBeInTheDocument();

    rerender(<ProfileForm initial={initialV4} section="target-search" />);
    await user.click(screen.getByRole("button", { name: "Rebase edits onto saved profile" }));
    expect(screen.getByDisplayValue("VP Engineering")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Head of Platform")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("Manual Architect")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Madrid")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(updateProfile).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/regenerate suggestions, and review them before saving/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Suggest roles" }));
    expect(await screen.findByText(
      "The saved evidence did not support a conservative role suggestion.",
    )).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(2));

    const retry = updateProfile.mock.calls[1]![0];
    expect(retry.expectedProfileVersion).toBe(4);
    expect(JSON.parse(retry.profileText)).toMatchObject({
      personal: { full_name: "External Canonical Name" },
      experience: {
        target_role: "VP Engineering; Manual Architect",
        target_locations: "Madrid",
      },
    });
    expect(JSON.parse(retry.profileText).experience.target_role).not.toContain("Head of Platform");
  });

  it("lets the user edit or reject transient suggestions before acceptance", async () => {
    const user = userEvent.setup();
    const targetRoleSuggestions = vi.fn(async () => ({
      ok: true as const,
      profileVersion: 3,
      suggestions: [
        {
          title: "Platform Director",
          classification: "direct" as const,
          track: "Management",
          seniority: "Director",
          evidenceIds: ["experience:exp-1"],
          rationale: "Recent saved title.",
        },
        {
          title: "Infrastructure Director",
          classification: "adjacent" as const,
          track: "Management",
          seniority: "Director",
          evidenceIds: ["experience:exp-1", "exp-1_bullet_1"],
          rationale: "Saved platform and reliability evidence.",
        },
      ],
      strategy: "model" as const,
      warnings: ["stubbed_model_evidence"],
    }));
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} section="target-search" />, {
      ports: buildTestPorts({ api: { targetRoleSuggestions } }),
    });

    await user.click(screen.getByRole("button", { name: "Suggest roles" }));
    expect(
      await screen.findByText("This demo result uses deterministic fixture evidence; no model ran."),
    ).toBeInTheDocument();
    const edited = await screen.findByLabelText("Suggested role 2");
    await user.clear(edited);
    await user.type(edited, "Head of Infrastructure");
    await user.click(screen.getByRole("button", { name: "Reject Platform Director" }));
    await user.click(screen.getByRole("button", { name: "Add selected roles" }));

    expect(screen.getByLabelText("Target roles 1")).toHaveValue("Head of Infrastructure");
    expect(screen.queryByDisplayValue("Platform Director")).not.toBeInTheDocument();
  });

  it("shows provider failure without changing target roles", async () => {
    const user = userEvent.setup();
    const targetRoleSuggestions = vi.fn(async () => {
      throw new Error("Suggestions are temporarily unavailable.");
    });
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} section="target-search" />, {
      ports: buildTestPorts({ api: { targetRoleSuggestions } }),
    });

    await user.click(screen.getByRole("button", { name: "Suggest roles" }));

    expect(await screen.findByText("Suggestions are temporarily unavailable.")).toBeInTheDocument();
    expect(screen.getByLabelText("Target roles 1")).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Add selected roles" })).not.toBeInTheDocument();
  });

  it("labels the production bounded-provider fallback honestly", async () => {
    const user = userEvent.setup();
    const targetRoleSuggestions = vi.fn(async () => ({
      ok: true as const,
      profileVersion: 3,
      suggestions: [],
      strategy: "none" as const,
      warnings: ["provider_token_or_cost_bound_unsupported"],
    }));
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} section="target-search" />, {
      ports: buildTestPorts({ api: { targetRoleSuggestions } }),
    });

    await user.click(screen.getByRole("button", { name: "Suggest roles" }));

    expect(await screen.findByText(
      "The configured provider cannot enforce this feature's token and spend ceiling, so only an exact saved title may appear.",
    )).toBeInTheDocument();
    expect(screen.getByLabelText("Target roles 1")).toHaveValue("");
  });

  it("keeps ordinary manual target-role persistence version-agnostic", async () => {
    const user = userEvent.setup();
    const updateProfile = vi.fn(async (request) => ({
      ...sampleProfileResponse,
      profileVersion: 4,
      profile: JSON.parse(request.profileText),
    }));
    renderWithProviders(<ProfileForm initial={sampleProfileResponse} section="target-search" />, {
      ports: buildTestPorts({ api: { updateProfile } }),
    });

    await user.type(screen.getByLabelText("Target roles 1"), "Staff Engineer");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));

    expect(updateProfile.mock.calls[0]![0]).not.toHaveProperty("expectedProfileVersion");
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
