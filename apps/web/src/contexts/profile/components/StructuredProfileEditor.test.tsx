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
    expect(screen.getAllByText("must appear in final resume").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Required").length).toBeGreaterThan(0);
  });

  it("renders bullet standards as a combined fixed set", () => {
    render(<StatefulEditor mode="preferences" />);

    expect(screen.queryByLabelText("Bullet style")).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Bullet standards" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Impact" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Technical depth" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Leadership" })).toBeChecked();
  });

  it("adds, edits, and removes achievement evidence", async () => {
    let latestProfile = JSON.stringify(sampleProfileResponse.profile, null, 2);
    render(<StatefulEditor onLatestProfile={(value) => { latestProfile = value; }} />);

    fireEvent.click(screen.getByRole("button", { name: "add evidence" }));
    expect(
      JSON.parse(latestProfile).resume.experience_entries[0].achievement_evidence[0],
    ).toMatchObject({
      id: "ev_exp-1_1",
      evidence_strength: "supported",
      user_confirmed: false,
    });

    fireEvent.change(await screen.findByLabelText("Source text"), {
      target: { value: "Reduced incident response time 35%." },
    });
    expect(
      JSON.parse(latestProfile).resume.experience_entries[0].achievement_evidence[0]
        .source_text,
    ).toBe("Reduced incident response time 35%.");

    fireEvent.click(screen.getByRole("button", { name: "Remove achievement evidence 1" }));
    expect(JSON.parse(latestProfile).resume.experience_entries[0].achievement_evidence).toEqual([]);
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
