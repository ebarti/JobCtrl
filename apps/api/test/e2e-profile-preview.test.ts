import { describe, expect, it } from "vitest";
import type { ResumeTemplateTheme } from "@jobctrl/contracts";
import { e2eProfilePreviewRenderer } from "./fixtures/e2e-profile-preview.js";

const render = (profile: unknown) => e2eProfilePreviewRenderer(
  { profile, templateText: "synthetic", resumeTheme: {} as ResumeTemplateTheme },
  { appDir: "/unused-in-memory-fixture", dbPath: "/unused-in-memory-fixture/db" },
);

describe("isolated profile preview fixture", () => {
  it("binds current escaped text to stable entries and distinct line numbers", async () => {
    const first = { id: 'first"entry', title: "Lead", summary: "First summary", bullets: ["Built <12> systems.", "First unique bullet"] };
    const second = { id: "second", title: "Engineer", summary: "Second summary", bullets: ["Second unique bullet"] };
    const profile = { personal: { full_name: "A & B <script>" }, resume: {
      executive_profile: { baseline_text: "Executive summary" }, experience_entries: [first, second],
    } };
    const initial = await render(profile);
    expect(initial.htmlText).toContain("A &amp; B &lt;script&gt;");
    expect(initial.htmlText).toContain('data-resume-layout-target="experience:first&quot;entry:bullet:1"');
    expect(initial.htmlText).toContain("Built &lt;12&gt; systems.");
    const lineNumbers = [...initial.htmlText.matchAll(/data-resume-line-number="(\d+)"/g)].map((match) => match[1]);
    expect(new Set(lineNumbers).size).toBe(lineNumbers.length);
    profile.personal.full_name = "Saved candidate";
    profile.resume.experience_entries.reverse();
    const refreshed = await render(profile);
    expect(refreshed.htmlText).toContain("Saved candidate");
    expect(refreshed.htmlText.indexOf("Second unique bullet")).toBeLessThan(refreshed.htmlText.indexOf("First unique bullet"));
    expect(initial.htmlText).not.toContain("Saved candidate");
  });
});
