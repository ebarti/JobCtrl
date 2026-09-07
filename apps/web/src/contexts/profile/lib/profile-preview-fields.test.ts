import { ProfileSchema } from "@jobctrl/contracts";
import { describe, expect, it } from "vitest";

import { sampleProfileResponse } from "../../../test/fixtures/projections.js";
import { bindProfilePreviewFields } from "./profile-preview-fields.js";

const profile = () => {
  const value = ProfileSchema.parse(sampleProfileResponse.profile);
  value.personal.address = "42 Fixture Road";
  value.personal.city = "London";
  value.personal.postal_code = "W1";
  value.personal.country = "UK";
  value.resume.experience_entries = [{ id: "role:5", company: "First & Second", title: "Engineer’s Lead",
    location: "London | Remote", date_range: "Jan 2020 – Present", summary: "Led teams.", bullets: ["Built 10 systems."], achievement_evidence: [] }];
  value.resume.education_entries = [{ id: "edu:1", institution: "Fixture | University", location: "London", date: "2020", degree: "MSc" }];
  value.resume.skill_categories = [{ id: "skills:1", label: "Tools: Core", items: ["CI, CD", "C++"] }];
  return value;
};
const html = `<main class="resume-page">
  <p data-resume-layout-target="personal:address">42 Fixture Road, London - W1 UK</p>
  <div data-resume-layout-target="experience:role:5:heading">
    <span class="resume-entry-company">First &amp; Second</span><span class="resume-entry-location">London | Remote</span>
    <span class="resume-entry-title">Engineer's Lead</span><span class="resume-entry-date">Jan 2020 - Present</span>
  </div>
  <div data-resume-layout-target="education:edu:1:subtitle"><span class="resume-entry-institution">Fixture | University | London</span><span class="resume-entry-date">2020</span></div>
  <p data-resume-layout-target="education:edu:1:degree">MSc</p>
  <li data-resume-layout-target="skills:skills:1"><b>Tools: Core:</b> CI, CD, C++</li>
</main>`;

describe("baseline preview field ownership", () => {
  it("binds individual fields without parsing separators that occur inside their values", () => {
    const doc = new DOMParser().parseFromString(bindProfilePreviewFields(html, profile()), "text/html");
    const values = Object.fromEntries(Array.from(doc.querySelectorAll("[data-resume-profile-field]")).map((node) =>
      [node.getAttribute("data-resume-profile-field"), node.getAttribute("data-resume-profile-source")]));
    expect(values).toMatchObject({
      "experience:role:5:title": "Engineer’s Lead", "experience:role:5:location": "London | Remote",
      "experience:role:5:date_range": "Jan 2020 – Present", "education:edu:1:institution": "Fixture | University",
      "education:edu:1:location": "London", "education:edu:1:date": "2020", "education:edu:1:degree": "MSc",
      "skills:skills:1:label": "Tools: Core", "skills:skills:1:item:1": "CI, CD", "skills:skills:1:item:2": "C++",
      "personal:address": "42 Fixture Road", "personal:city": "London", "personal:postal_code": "W1", "personal:country": "UK",
    });
    expect(doc.querySelector('[data-resume-layout-target="personal:address"]')?.textContent).toBe("42 Fixture Road, London - W1 UK");
    expect(doc.querySelector('[data-resume-layout-target="skills:skills:1"]')?.textContent).toBe("Tools: Core: CI, CD, C++");
  });

  it("marks a stale or incompatible preview as conflicting instead of giving it a newer source value", () => {
    const changed = profile();
    changed.resume.experience_entries[0]!.title = "Newer boxed title";
    changed.resume.skill_categories[0]!.items = ["Newer skill"];
    const doc = new DOMParser().parseFromString(bindProfilePreviewFields(html, changed), "text/html");
    expect(doc.querySelector('.resume-entry-title')?.getAttribute("data-resume-profile-field")).toBe("unmapped:experience:role:5:title");
    expect(doc.querySelector('.resume-entry-title')?.hasAttribute("data-resume-profile-source")).toBe(false);
    expect(doc.querySelector('[data-resume-layout-target="skills:skills:1"]')?.getAttribute("data-resume-profile-field")).toBe("unmapped:skills:skills:1");
  });

  it("does not treat an abbreviated link caption as a canonical URL value", () => {
    const source = profile();
    source.personal.linkedin_url = "https://www.linkedin.com/in/fixture";
    const document = new DOMParser().parseFromString(bindProfilePreviewFields('<p data-resume-layout-target="personal:contact"><span class="resume-contact-linkedin"><a href="https://www.linkedin.com/in/fixture">fixture</a></span></p>', source), "text/html");
    const link = document.querySelector("a");
    expect(link?.textContent).toBe("fixture");
    expect(link?.hasAttribute("data-resume-profile-field")).toBe(false);
    expect(link?.getAttribute("href")).toBe("https://www.linkedin.com/in/fixture");
  });
});
