import { fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { sampleProfileResponse } from "../../../test/fixtures/projections.js";
import { StructuredProfileEditor } from "./StructuredProfileEditor.js";

type ProfileFixture = Record<string, unknown> & {
  personal: Record<string, unknown>;
};

const googleAddressSelection = vi.hoisted(() => ({
  current: {
    address: "17 Carrer Joan Maragall",
    city: "Cabrera de Mar",
    country: "Spain",
    postalCode: "08349",
    provinceState: "",
  },
}));

vi.mock("./GoogleAddressSearchField.js", () => ({
  GoogleAddressSearchField: ({
    value,
    onAddressChange,
    onAddressSelect,
  }: {
    value: string;
    onAddressChange: (value: string) => void;
    onAddressSelect: (selection: typeof googleAddressSelection.current) => void;
  }) => (
    <div className="field google-address-field">
      <label htmlFor="mock-google-address">Address</label>
      <input
        id="mock-google-address"
        value={value}
        onChange={(event) => onAddressChange(event.target.value)}
      />
      <button type="button" onClick={() => onAddressSelect(googleAddressSelection.current)}>
        Select Google address
      </button>
    </div>
  ),
  isUnitedStatesAddressCountry: (country: string) =>
    ["us", "usa", "united states", "united states of america"].includes(country.trim().toLowerCase()),
}));

function StatefulEditor({
  initialProfile = sampleProfileResponse.profile,
  mode,
  onLatestProfile = () => undefined,
}: {
  initialProfile?: unknown;
  mode?: "profile" | "preferences";
  onLatestProfile?: (value: string) => void;
}) {
  const [profileText, setProfileText] = useState(JSON.stringify(initialProfile, null, 2));
  const [styleText, setStyleText] = useState(JSON.stringify(sampleProfileResponse.style, null, 2));
  const updateProfile = (value: string) => {
    onLatestProfile(value);
    setProfileText(value);
  };
  const modeProps = mode ? { mode } : {};
  return (
    <StructuredProfileEditor
      {...modeProps}
      profileText={profileText}
      styleText={styleText}
      onProfileTextChange={updateProfile}
      onStyleTextChange={setStyleText}
    />
  );
}

function storedValueAt(profileText: string, path: string) {
  return path.split(".").reduce<unknown>((value, key) => {
    if (typeof value !== "object" || value === null) {
      return undefined;
    }
    return (value as Record<string, unknown>)[key];
  }, JSON.parse(profileText));
}

describe("<StructuredProfileEditor>", () => {
  it("marks profile and preferences disclosure subjects as equal card stacks", () => {
    const { container, rerender } = render(<StatefulEditor mode="profile" />);

    expect(
      container.querySelector(".profile-sections--card-stack"),
    ).toBeInTheDocument();
    expect(
      container.querySelector(".profile-sections--resume-data"),
    ).toBeInTheDocument();

    rerender(<StatefulEditor mode="preferences" />);

    expect(
      container.querySelector(".profile-sections--card-stack"),
    ).toBeInTheDocument();
    expect(
      container.querySelector(".profile-sections--resume-data"),
    ).not.toBeInTheDocument();
  });

  it("round-trips persisted Yes/No preferences through accessible checkboxes", async () => {
    const user = userEvent.setup();
    const initialProfile = JSON.parse(JSON.stringify(sampleProfileResponse.profile));
    initialProfile.work_authorization = {
      legally_authorized_to_work: "Yes",
      require_sponsorship: "No",
    };
    initialProfile.availability = {
      available_for_full_time: "Yes",
      available_for_contract: "No",
    };
    let latestProfile = JSON.stringify(initialProfile, null, 2);

    render(
      <StatefulEditor
        mode="preferences"
        initialProfile={initialProfile}
        onLatestProfile={(value) => { latestProfile = value; }}
      />,
    );

    const cases = [
      ["Legally authorized to work", "work_authorization.legally_authorized_to_work", "Yes"],
      ["Requires sponsorship", "work_authorization.require_sponsorship", "No"],
      ["Available full-time", "availability.available_for_full_time", "Yes"],
      ["Available for contract", "availability.available_for_contract", "No"],
    ] as const;

    for (const [label, path, initialValue] of cases) {
      const checkbox = screen.getByRole("checkbox", { name: label });
      expect(screen.queryByRole("combobox", { name: label })).not.toBeInTheDocument();
      expect(checkbox).toHaveAttribute("aria-checked", initialValue === "Yes" ? "true" : "false");

      await user.click(checkbox);
      expect(storedValueAt(latestProfile, path)).toBe(initialValue === "Yes" ? "No" : "Yes");

      checkbox.focus();
      await user.keyboard(" ");
      expect(storedValueAt(latestProfile, path)).toBe(initialValue);
    }
  });

  it("renders unanswered preferences honestly without a separate clear action", async () => {
    const user = userEvent.setup();
    const initialProfile = JSON.parse(JSON.stringify(sampleProfileResponse.profile));
    initialProfile.work_authorization = {
      legally_authorized_to_work: "",
      require_sponsorship: "",
    };
    initialProfile.availability = {
      available_for_full_time: "",
      available_for_contract: "",
    };
    let latestProfile = JSON.stringify(initialProfile, null, 2);

    render(
      <StatefulEditor
        mode="preferences"
        initialProfile={initialProfile}
        onLatestProfile={(value) => { latestProfile = value; }}
      />,
    );

    const checkbox = screen.getByRole("checkbox", { name: "Legally authorized to work" });

    expect(checkbox).toHaveAttribute("aria-checked", "mixed");
    expect(checkbox).toHaveAccessibleDescription("Not answered");
    expect(screen.queryByText("Clear answer")).not.toBeInTheDocument();
    expect(storedValueAt(latestProfile, "work_authorization.legally_authorized_to_work")).toBe("");

    await user.click(checkbox);
    expect(checkbox).toHaveAttribute("aria-checked", "true");
    expect(checkbox).toHaveAccessibleDescription("Selected: Yes");
    expect(storedValueAt(latestProfile, "work_authorization.legally_authorized_to_work")).toBe("Yes");

    await user.click(checkbox);
    expect(checkbox).toHaveAttribute("aria-checked", "false");
    expect(checkbox).toHaveAccessibleDescription("Selected: No");
    expect(storedValueAt(latestProfile, "work_authorization.legally_authorized_to_work")).toBe("No");
  });

  it("explains currency conversion guidance without changing its stored field", () => {
    const initialProfile = JSON.parse(JSON.stringify(sampleProfileResponse.profile));
    initialProfile.compensation = {
      currency_conversion_note: "Convert the posted midpoint to EUR.",
    };
    let latestProfile = JSON.stringify(initialProfile, null, 2);

    render(
      <StatefulEditor
        mode="preferences"
        initialProfile={initialProfile}
        onLatestProfile={(value) => { latestProfile = value; }}
      />,
    );

    const input = screen.getByLabelText("Currency conversion guidance");
    expect(input).toHaveValue("Convert the posted midpoint to EUR.");
    expect(input).toHaveAccessibleDescription(
      "Used for salary questions when a job posting lists compensation in a different currency.",
    );
    expect(screen.queryByLabelText("Currency note")).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: "Use the ECB rate for the posted midpoint." } });

    expect(storedValueAt(latestProfile, "compensation.currency_conversion_note")).toBe(
      "Use the ECB rate for the posted midpoint.",
    );
  });

  it("exposes only invented adjacent experience as the editable claim control", () => {
    let latestProfile = JSON.stringify(sampleProfileResponse.profile, null, 2);
    render(<StatefulEditor mode="preferences" onLatestProfile={(value) => { latestProfile = value; }} />);

    expect(screen.queryByLabelText("Tailoring mode")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("AI may make minor inferred phrasing")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Allow adjacent achievement drafts")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Generation claim scope" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Broadest generated claim")).not.toBeInTheDocument();
    expect(screen.queryByText("Review bypass rules")).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Adjacent experience claims" })).toBeInTheDocument();

    const toggle = screen.getByRole("checkbox", { name: "Enable profile enhancement" });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);

    let profile = JSON.parse(latestProfile);
    expect(profile.resume.tailoring_rules.tailoring_policy.claim_mode).toBe(
      "draft_requires_confirmation",
    );
    expect(profile.resume.tailoring_rules.tailoring_policy.allow_minor_inference).toBe(true);
    expect(profile.resume.tailoring_rules.tailoring_policy.allow_adjacent_achievement_drafts).toBe(true);
    expect(profile.resume.tailoring_rules.tailoring_policy.auto_approvable_claim_modes).toEqual([
      "verified_only",
      "evidence_reframing",
    ]);

    fireEvent.click(screen.getByRole("checkbox", { name: "Enable profile enhancement" }));

    profile = JSON.parse(latestProfile);
    expect(profile.resume.tailoring_rules.tailoring_policy.claim_mode).toBe(
      "adjacent_translation",
    );
    expect(profile.resume.tailoring_rules.tailoring_policy.allow_minor_inference).toBe(true);
    expect(profile.resume.tailoring_rules.tailoring_policy.allow_adjacent_achievement_drafts).toBe(false);
    expect(profile.resume.tailoring_rules.tailoring_policy.auto_approvable_claim_modes).toEqual([
      "verified_only",
      "evidence_reframing",
    ]);
  });

  it("checks invented adjacent experience for legacy adjacent draft policies", () => {
    const initialProfile = JSON.parse(JSON.stringify(sampleProfileResponse.profile));
    initialProfile.resume.tailoring_rules.tailoring_policy = {
      ...initialProfile.resume.tailoring_rules.tailoring_policy,
      claim_mode: "draft_requires_confirmation",
      allow_adjacent_achievement_drafts: true,
    };

    render(<StatefulEditor mode="preferences" initialProfile={initialProfile} />);

    expect(screen.getByRole("checkbox", { name: "Enable profile enhancement" })).toBeChecked();
  });

  it("normalizes legacy non-draft claim policies when editing other Preferences fields", () => {
    const initialProfile = JSON.parse(JSON.stringify(sampleProfileResponse.profile));
    initialProfile.resume.tailoring_rules.tailoring_policy = {
      ...initialProfile.resume.tailoring_rules.tailoring_policy,
      claim_mode: "evidence_reframing",
      allow_minor_inference: false,
      allow_adjacent_achievement_drafts: false,
      auto_approvable_claim_modes: ["verified_only", "evidence_reframing"],
    };
    let latestProfile = JSON.stringify(initialProfile, null, 2);

    render(
      <StatefulEditor
        mode="preferences"
        initialProfile={initialProfile}
        onLatestProfile={(value) => { latestProfile = value; }}
      />,
    );

    expect(screen.getByRole("checkbox", { name: "Enable profile enhancement" })).not.toBeChecked();
    fireEvent.change(screen.getByLabelText("Minimum fit score"), { target: { value: "9" } });

    const profile = JSON.parse(latestProfile);
    expect(profile.resume.tailoring_rules.tailoring_policy).toMatchObject({
      claim_mode: "adjacent_translation",
      allow_minor_inference: true,
      allow_adjacent_achievement_drafts: false,
      auto_approvable_claim_modes: ["verified_only", "evidence_reframing"],
    });
  });

  it("keeps experience title changes disabled in generation permissions", () => {
    render(<StatefulEditor mode="preferences" />);

    expect(screen.queryByLabelText("AI may reframe experience titles")).not.toBeInTheDocument();
    const changeTitles = screen.getByRole("checkbox", { name: "Change experience titles" });
    expect(changeTitles).toHaveAttribute("aria-disabled", "true");
    expect(changeTitles).toHaveAccessibleDescription(
      "Experience titles remain fixed to profile evidence during tailoring.",
    );
  });

  it("labels keyword density as advisory emphasis and edits revision gates", () => {
    let latestProfile = JSON.stringify(sampleProfileResponse.profile, null, 2);
    render(<StatefulEditor mode="preferences" onLatestProfile={(value) => { latestProfile = value; }} />);

    expect(screen.queryByLabelText("Keyword density")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Keyword emphasis")).toBeInTheDocument();
    expect(screen.getByLabelText("Minimum fit score")).toHaveValue(8);
    expect(screen.getByLabelText("Must-have coverage (%)")).toHaveValue(85);
    expect(screen.getByLabelText("Revision attempts")).toHaveValue(1);
    expect(screen.getByLabelText("Additional guidance")).toHaveAttribute("maxlength", "1200");

    fireEvent.change(screen.getByLabelText("Minimum fit score"), { target: { value: "9" } });
    fireEvent.change(screen.getByLabelText("Must-have coverage (%)"), { target: { value: "90" } });
    fireEvent.change(screen.getByLabelText("Revision attempts"), { target: { value: "2" } });

    const profile = JSON.parse(latestProfile);
    expect(profile.resume.tailoring_rules.revision_gates).toMatchObject({
      min_fit_score: 9,
      must_have_coverage: 0.9,
      max_revision_attempts: 2,
    });
  });

  it("keeps required content pins out of Preferences because Profile owns them", () => {
    render(<StatefulEditor mode="preferences" />);

    expect(screen.queryByRole("group", { name: "Required content pins" })).not.toBeInTheDocument();
    expect(screen.queryByText("Experience entries")).not.toBeInTheDocument();
    expect(screen.queryByText("Experience bullets")).not.toBeInTheDocument();
    expect(screen.queryByText("Skill groups")).not.toBeInTheDocument();
  });

  it("keeps required content pins configurable from the Profile editor", () => {
    render(<StatefulEditor />);

    expect(screen.getByRole("heading", { name: "Experience entries" })).toBeInTheDocument();
    expect(screen.getAllByText("Must appear in final resume").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Required").length).toBeGreaterThan(0);
  });

  it("renders bullet standards as a combined fixed set", () => {
    render(<StatefulEditor mode="preferences" />);

    expect(screen.queryByLabelText("Bullet style")).not.toBeInTheDocument();
    const bulletStandards = screen.getByRole("group", { name: "Bullet standards" });
    expect(within(bulletStandards).getByRole("link", { name: "Guide" })).toHaveAttribute(
      "data-typography",
      "control",
    );
    for (const name of ["Impact", "Technical depth", "Leadership"]) {
      const standard = within(bulletStandards).getByRole("checkbox", { name });
      expect(standard).toBeChecked();
      expect(standard).toHaveAttribute("aria-disabled", "true");
      expect(standard).toHaveAccessibleDescription(
        "Required for evidence-quality resumes and cannot be disabled.",
      );
    }
  });

  it("uses adaptive property grids for profile fields", () => {
    render(<StatefulEditor />);

    const fullNameGrid = screen
      .getByLabelText("Full name")
      .closest('[data-slot="adaptive-field-grid"]');
    const experienceGrid = screen
      .getByLabelText("Current job title")
      .closest('[data-slot="adaptive-field-grid"]');
    const eeoGrid = screen.getByLabelText("Gender").closest('[data-slot="adaptive-field-grid"]');

    expect(fullNameGrid).not.toBeNull();
    expect(experienceGrid).not.toBeNull();
    expect(eeoGrid).not.toBeNull();
    expect(document.querySelector(".profile-sections .field-grid")).not.toBeInTheDocument();
  });

  it("uses adaptive property grids for application and resume preferences", () => {
    render(<StatefulEditor mode="preferences" />);

    const applicationGrid = screen
      .getByLabelText("Salary currency")
      .closest('[data-slot="adaptive-field-grid"]');
    const styleGrid = screen
      .getByLabelText("Page scale")
      .closest('[data-slot="adaptive-field-grid"]');

    expect(applicationGrid).not.toBeNull();
    expect(styleGrid).not.toBeNull();
    expect(applicationGrid).not.toBe(styleGrid);
    expect(document.querySelector(".profile-sections .field-grid")).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Work authorization and account" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Availability" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Compensation" })).toBeInTheDocument();
    expect(screen.getByLabelText("Salary expectation")).toHaveAccessibleDescription(
      "Annual gross amount in the selected currency.",
    );
    expect(screen.getByLabelText("Salary currency")).toHaveAccessibleDescription(
      "Three-letter currency code, such as EUR or USD.",
    );
    expect(
      screen.getByRole("heading", { name: "Application configuration" }).closest("section"),
    ).toHaveAttribute("id", "preferences-application");
  });

  it("keeps the tailoring field contract grouped behind semantic keyboard tabs", async () => {
    const user = userEvent.setup();
    render(<StatefulEditor mode="preferences" />);

    const tablist = screen.getByRole("tablist", { name: "Tailoring control sections" });
    const contentTab = within(tablist).getByRole("tab", { name: "Content rules" });
    const writingTab = within(tablist).getByRole("tab", { name: "Writing style" });
    const qualityTab = within(tablist).getByRole("tab", { name: "Quality gates" });
    const panelFor = (tab: HTMLElement) => {
      const panelId = tab.getAttribute("aria-controls");
      if (!panelId) throw new Error("Tailoring tab did not identify its panel");
      const panel = document.getElementById(panelId);
      if (!panel) throw new Error(`Missing tailoring panel ${panelId}`);
      return within(panel);
    };

    expect(contentTab).toHaveAttribute("aria-selected", "true");
    for (const label of [
      "Enable profile enhancement",
      "Rewrite executive summary",
      "Rewrite achievement bullets",
      "Select and order existing skills",
      "Change experience titles",
      "Impact",
      "Technical depth",
      "Leadership",
    ]) {
      expect(panelFor(contentTab).getByText(label, { selector: "label" })).toBeInTheDocument();
      expect(panelFor(writingTab).queryByText(label, { selector: "label" })).not.toBeInTheDocument();
      expect(panelFor(qualityTab).queryByText(label, { selector: "label" })).not.toBeInTheDocument();
    }
    for (const label of [
      "Writing tone",
      "Verbosity",
      "Keyword emphasis",
      "Avoid first-person language",
      "Additional guidance",
    ]) {
      expect(panelFor(writingTab).getByText(label, { selector: "label" })).toBeInTheDocument();
      expect(panelFor(contentTab).queryByText(label, { selector: "label" })).not.toBeInTheDocument();
      expect(panelFor(qualityTab).queryByText(label, { selector: "label" })).not.toBeInTheDocument();
    }
    for (const label of ["Minimum fit score", "Must-have coverage (%)", "Revision attempts"]) {
      expect(panelFor(qualityTab).getByText(label, { selector: "label" })).toBeInTheDocument();
      expect(panelFor(contentTab).queryByText(label, { selector: "label" })).not.toBeInTheDocument();
      expect(panelFor(writingTab).queryByText(label, { selector: "label" })).not.toBeInTheDocument();
    }

    await user.click(contentTab);
    await user.keyboard("{ArrowRight}");
    expect(writingTab).toHaveFocus();
    expect(writingTab).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{End}");
    expect(qualityTab).toHaveFocus();
    expect(qualityTab).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Home}");
    expect(contentTab).toHaveFocus();
    expect(contentTab).toHaveAttribute("aria-selected", "true");
  });

  it("preserves a tailoring draft while switching tabs and collapsing the section", async () => {
    const user = userEvent.setup();
    render(<StatefulEditor mode="preferences" />);

    await user.click(screen.getByRole("tab", { name: "Writing style" }));
    const guidance = screen.getByLabelText("Additional guidance");
    await user.clear(guidance);
    await user.type(guidance, "Keep the executive summary concise.");

    await user.click(screen.getByRole("tab", { name: "Quality gates" }));
    expect(guidance).toBeInTheDocument();
    expect(guidance).toHaveValue("Keep the executive summary concise.");

    const disclosure = screen.getByRole("button", { name: /^Tailoring controls\b/i });
    await user.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(guidance).toBeInTheDocument();
    expect(guidance).toHaveValue("Keep the executive summary concise.");

    await user.click(disclosure);
    await user.click(screen.getByRole("tab", { name: "Writing style" }));
    expect(screen.getByLabelText("Additional guidance")).toBe(guidance);
    expect(guidance).toHaveValue("Keep the executive summary concise.");
  });

  it("preserves extracted achievement evidence without exposing it as profile input", () => {
    const initialProfile = JSON.parse(JSON.stringify(sampleProfileResponse.profile));
    initialProfile.resume.experience_entries[0].achievement_evidence = [
      {
        id: "exp-1_bullet_1",
        source_text: "Scaled the platform 10x.",
        scope: "Director of Platform Initech",
        action: "Scaled the platform 10x.",
        tools: [],
        metrics: ["10x"],
        outcome: "Scaled the platform 10x.",
        seniority_signal: "",
        evidence_strength: "supported",
        claim_confidence: 0.8,
        user_confirmed: true,
        tags: [],
      },
    ];
    let latestProfile = JSON.stringify(initialProfile, null, 2);

    render(<StatefulEditor initialProfile={initialProfile} onLatestProfile={(value) => { latestProfile = value; }} />);

    expect(screen.queryByRole("group", { name: "Achievement evidence" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Proof points for generated claims" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add evidence/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add proof point/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Evidence ID")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Source text")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Verified resume metrics")).not.toBeInTheDocument();
    expect(
      screen.getAllByText(/JobCtrl extracts metrics from the bullet/i).length,
    ).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Director of Reliability" } });

    const profile = JSON.parse(latestProfile);
    expect(profile.resume.experience_entries[0].title).toBe("Director of Reliability");
    expect(profile.resume.experience_entries[0].achievement_evidence).toEqual(
      initialProfile.resume.experience_entries[0].achievement_evidence,
    );
  });

  it("hides state/province for non-US profiles", () => {
    const baseProfile = sampleProfileResponse.profile as ProfileFixture;
    const initialProfile = {
      ...baseProfile,
      personal: {
        ...baseProfile.personal,
        country: "Spain",
        province_state: "Catalunya",
      },
    };

    render(<StatefulEditor initialProfile={initialProfile} onLatestProfile={() => undefined} />);

    expect(screen.queryByLabelText("State / province")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Country")).toHaveValue("Spain");
  });

  it("shows state/province for US profiles", () => {
    const baseProfile = sampleProfileResponse.profile as ProfileFixture;
    const initialProfile = {
      ...baseProfile,
      personal: {
        ...baseProfile.personal,
        country: "United States",
        province_state: "California",
      },
    };

    render(<StatefulEditor initialProfile={initialProfile} onLatestProfile={() => undefined} />);

    expect(screen.getByLabelText("State / province")).toHaveValue("California");
  });

  it("replaces structured address fields from a validated Google address selection", () => {
    const baseProfile = sampleProfileResponse.profile as ProfileFixture;
    const initialProfile = {
      ...baseProfile,
      personal: {
        ...baseProfile.personal,
        address: "Old address",
        city: "Old city",
        country: "Old country",
        postal_code: "99999",
        province_state: "Old state",
      },
    };
    let latestProfile = JSON.stringify(initialProfile, null, 2);
    render(
      <StatefulEditor
        initialProfile={initialProfile}
        onLatestProfile={(value) => {
          latestProfile = value;
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Select Google address" }));

    expect(JSON.parse(latestProfile).personal).toMatchObject({
      address: "17 Carrer Joan Maragall",
      city: "Cabrera de Mar",
      country: "Spain",
      postal_code: "08349",
      province_state: "",
    });

    googleAddressSelection.current = {
      address: "1 Plaza Mayor",
      city: "Madrid",
      country: "Spain",
      postalCode: "",
      provinceState: "",
    };

    fireEvent.click(screen.getByRole("button", { name: "Select Google address" }));

    expect(JSON.parse(latestProfile).personal).toMatchObject({
      address: "1 Plaza Mayor",
      city: "Madrid",
      country: "Spain",
      postal_code: "",
      province_state: "",
    });
  });
});
