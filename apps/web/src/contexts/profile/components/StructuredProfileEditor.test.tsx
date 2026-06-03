import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { sampleProfileResponse } from "../../../test/fixtures/projections.js";
import { StructuredProfileEditor } from "./StructuredProfileEditor.js";

function StatefulEditor({
  mode,
  onLatestProfile,
}: {
  mode?: "profile" | "preferences";
  onLatestProfile: (value: string) => void;
}) {
  const [profileText, setProfileText] = useState(
    JSON.stringify(sampleProfileResponse.profile, null, 2),
  );
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
});
