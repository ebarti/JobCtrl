import { fireEvent, render, screen } from "@testing-library/react";
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

describe("<StructuredProfileEditor>", () => {
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
    expect(screen.getByRole("checkbox", { name: "Change experience titles" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Change experience titles" })).toHaveAccessibleDescription(
      "Experience titles stay grounded in profile evidence.",
    );
  });

  it("uses disclosure sections and keeps tailoring controls mounted across tab changes", () => {
    let latestProfile = JSON.stringify(sampleProfileResponse.profile, null, 2);
    render(<StatefulEditor mode="preferences" onLatestProfile={(value) => { latestProfile = value; }} />);

    expect(screen.getByRole("heading", { name: "Application configurations", level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Tailoring controls", level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Resume style", level: 2 })).toBeInTheDocument();

    const tabs = screen.getByRole("tablist", { name: "Tailoring control sections" });
    expect(tabs).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Content rules" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Writing style" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Quality gates" })).toBeInTheDocument();

    const guidance = screen.getByLabelText("Additional guidance");
    expect(guidance.closest('[role="tabpanel"]')).toHaveAttribute("data-state", "inactive");

    fireEvent.click(screen.getByRole("tab", { name: "Writing style" }));
    expect(screen.getByLabelText("Additional guidance")).toBe(guidance);
    fireEvent.change(guidance, { target: { value: "Keep outcomes specific." } });

    fireEvent.click(screen.getByRole("tab", { name: "Quality gates" }));
    fireEvent.click(screen.getByRole("tab", { name: "Writing style" }));

    expect(screen.getByLabelText("Additional guidance")).toBe(guidance);
    expect(screen.getByLabelText("Additional guidance")).toHaveValue("Keep outcomes specific.");
    expect(JSON.parse(latestProfile).resume.tailoring_rules.custom_tailoring_prompt).toBe(
      "Keep outcomes specific.",
    );
    expect(screen.getByText("Tailoring inputs").closest("a")).toHaveAttribute(
      "href",
      "https://jobctrl.dev/architecture/tailoring#inputs-to-tailoring",
    );
    expect(screen.getByText("Post-generation fit gate").closest("a")).toHaveAttribute(
      "href",
      "https://jobctrl.dev/architecture/tailoring#6-post-generation-fit-gate",
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
    let latestProfile = JSON.stringify(sampleProfileResponse.profile, null, 2);
    render(<StatefulEditor onLatestProfile={(value) => { latestProfile = value; }} />);

    expect(screen.getByRole("heading", { name: "Experience entries" })).toBeInTheDocument();
    expect(screen.getAllByText("must appear in final resume").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Required").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("checkbox", { name: "must appear in final resume" }));
    expect(
      JSON.parse(latestProfile).resume.tailoring_rules.required_experience_entry_ids,
    ).toEqual(["exp-1"]);

    fireEvent.click(screen.getByRole("button", { name: "add bullet" }));
    expect(screen.getByLabelText("Bullet 3")).toBeInTheDocument();
    expect(JSON.parse(latestProfile).resume.experience_entries[0].bullets).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "Remove bullet 3" }));
    expect(screen.queryByLabelText("Bullet 3")).not.toBeInTheDocument();
    expect(JSON.parse(latestProfile).resume.experience_entries[0].bullets).toHaveLength(2);
  });

  it("groups Profile fields in keyboard-operable disclosures without unmounting collapsed editors", () => {
    const initialProfile = JSON.parse(JSON.stringify(sampleProfileResponse.profile));
    initialProfile.resume.education_entries = [
      {
        id: "education-1",
        date: "2020-06",
        degree: "BSc Computer Science",
        institution: "Example University",
        location: "Barcelona",
      },
    ];
    initialProfile.resume.skill_categories = [
      {
        id: "skills-1",
        label: "Platform engineering",
        items: ["TypeScript"],
      },
    ];
    initialProfile.eeo_voluntary = {
      gender: "Prefer not to say",
      race_ethnicity: "Prefer not to say",
      veteran_status: "Prefer not to say",
      disability_status: "Prefer not to say",
    };

    render(<StatefulEditor initialProfile={initialProfile} />);

    const personalTrigger = screen.getByRole("button", { name: /^Personal information/ });
    const baselineTrigger = screen.getByRole("button", { name: /^Resume baseline/ });
    const experienceTrigger = screen.getByRole("button", { name: /^Experience entries/ });
    const educationTrigger = screen.getByRole("button", { name: /^Education/ });
    const skillsTrigger = screen.getByRole("button", { name: /^Skill categories/ });
    const eeoTrigger = screen.getByRole("button", { name: /^Voluntary EEO/ });

    expect(personalTrigger).toHaveAttribute("aria-expanded", "true");
    expect(baselineTrigger).toHaveAttribute("aria-expanded", "true");
    expect(experienceTrigger).toHaveAttribute("aria-expanded", "true");
    expect(educationTrigger).toHaveAttribute("aria-expanded", "false");
    expect(skillsTrigger).toHaveAttribute("aria-expanded", "false");
    expect(eeoTrigger).toHaveAttribute("aria-expanded", "false");

    const degreeField = screen.getByLabelText("Degree");
    expect(degreeField.closest("[hidden]")).toBeInTheDocument();

    educationTrigger.focus();
    expect(educationTrigger).toHaveFocus();
    fireEvent.click(educationTrigger);

    expect(educationTrigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Degree")).toBe(degreeField);
    expect(degreeField.closest("[hidden]")).not.toBeInTheDocument();
  });

  it("renders bullet standards as a combined fixed set", () => {
    render(<StatefulEditor mode="preferences" />);

    expect(screen.queryByLabelText("Bullet style")).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Bullet standards" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Impact" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Technical depth" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Leadership" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Impact" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Technical depth" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Leadership" })).toBeDisabled();
    expect(screen.getByText("What these mean").closest("a")).toHaveAttribute(
      "href",
      "https://jobctrl.dev/architecture/tailoring#inputs-to-tailoring",
    );
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
