import { fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { sampleProfileResponse } from "../../../test/fixtures/projections.js";
import { recordAt, recordArrayAt, type JsonRecord } from "../lib/json-record.js";
import { StructuredProfileEditor } from "./StructuredProfileEditor.js";

vi.mock("./GoogleAddressSearchField.js", () => ({
  GoogleAddressSearchField: () => null,
  isUnitedStatesAddressCountry: () => false,
}));

function profileWithRoles(required?: string[]): JsonRecord {
  const profile = structuredClone(recordAt(sampleProfileResponse, "profile"));
  const resume = recordAt(profile, "resume");
  resume["experience_entries"] = ["first", "second", "third"].map((id) => ({
    id, title: `${id} role`, company: `${id} company`, date_range: "", location: "", summary: "",
    bullets: [`${id} synthetic work.`], achievement_evidence: [],
  }));
  const rules = recordAt(resume, "tailoring_rules");
  if (required === undefined) delete rules["required_experience_entry_ids"];
  else rules["required_experience_entry_ids"] = required;
  rules["required_bullets_by_experience_id"] = {};
  return profile;
}

function Editor({ initial, onChange }: {initial: JsonRecord; onChange: (value: JsonRecord) => void}) {
  const [profile, setProfile] = useState(initial);
  return <StructuredProfileEditor profile={profile} style={recordAt(sampleProfileResponse, "style")}
    onProfileChange={(value) => { setProfile(value); onChange(value); }} onStyleChange={() => undefined} />;
}

function expandExperience() {
  const toggle = screen.getByRole("button", { name: /^Experience entries\b/ });
  if (toggle.getAttribute("aria-expanded") === "false") fireEvent.click(toggle);
}

function requiredControl(role: string) {
  return within(screen.getByRole("group", { name: `${role} company - ${role} role` }))
    .getByRole("checkbox", { name: "Must appear in final resume" });
}

function included(profile: JsonRecord) {
  return recordAt(recordAt(profile, "resume"), "tailoring_rules")["required_experience_entry_ids"];
}

describe("experience inclusion defaults", () => {
  it.each([{ ids: undefined }, { ids: [] }])("displays an unconfigured list as all included without changing the profile: %j", ({ ids }) => {
    const changed = vi.fn();
    render(<Editor initial={profileWithRoles(ids)} onChange={changed} />);
    expandExperience();
    for (const role of ["first", "second", "third"]) expect(requiredControl(role)).toBeChecked();
    expect(changed).not.toHaveBeenCalled();
  });

  it("unchecking a default role keeps every other role included", async () => {
    const user = userEvent.setup();
    let latest = profileWithRoles([]);
    render(<Editor initial={latest} onChange={(value) => { latest = value; }} />);
    expandExperience();
    await user.click(requiredControl("second"));
    expect(included(latest)).toEqual(["first", "third"]);
    expect(requiredControl("first")).toBeChecked();
    expect(requiredControl("second")).not.toBeChecked();
    expect(requiredControl("third")).toBeChecked();
  });

  it("preserves an explicit saved subset and keeps its last required role selected", () => {
    const changed = vi.fn();
    render(<Editor initial={profileWithRoles(["second"])} onChange={changed} />);
    expandExperience();
    expect(requiredControl("first")).not.toBeChecked();
    expect(requiredControl("second")).toBeChecked();
    expect(requiredControl("second")).toHaveAttribute("aria-disabled", "true");
    expect(requiredControl("third")).not.toBeChecked();
    fireEvent.click(requiredControl("second"));
    expect(changed).not.toHaveBeenCalled();
  });

  it.each([{ ids: [] }, { ids: ["second"] }])("includes newly added roles without narrowing an existing selection: %j", async ({ ids }) => {
    const user = userEvent.setup();
    const initial = profileWithRoles(ids);
    let latest = initial;
    render(<Editor initial={initial} onChange={(value) => { latest = value; }} />);
    expandExperience();
    await user.click(screen.getByRole("button", { name: "Add experience" }));
    const roles = recordArrayAt(latest, "resume.experience_entries");
    const addedId = roles.at(-1)!["id"];
    expect(included(latest)).toEqual([...(ids.length ? ids : ["first", "second", "third"]), addedId]);
    expect(roles.slice(0, 3)).toEqual(recordAt(initial, "resume")["experience_entries"]);
  });
});
