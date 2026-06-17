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
}));

function StatefulEditor({
  initialProfile = sampleProfileResponse.profile,
  mode,
  onLatestProfile,
}: {
  initialProfile?: unknown;
  mode?: "profile" | "preferences";
  onLatestProfile: (value: string) => void;
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
  it("edits claim mode and auto-approvable claim controls", () => {
    let latestProfile = JSON.stringify(sampleProfileResponse.profile, null, 2);
    render(<StatefulEditor mode="preferences" onLatestProfile={(value) => { latestProfile = value; }} />);

    fireEvent.change(screen.getByLabelText("Claim mode"), {
      target: { value: "draft_requires_confirmation" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Verified facts only" }));

    const profile = JSON.parse(latestProfile);
    expect(profile.resume.tailoring_rules.tailoring_policy.claim_mode).toBe(
      "draft_requires_confirmation",
    );
    expect(profile.resume.tailoring_rules.tailoring_policy.auto_approvable_claim_modes).toEqual([
      "verified_only",
    ]);
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
