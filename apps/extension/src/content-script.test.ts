// @vitest-environment jsdom

import type { ExtensionAutofillProfileField } from "@jobhunter/contracts";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let getBoundingClientRectSpy: ReturnType<typeof vi.spyOn>;
let getClientRectsSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  vi.stubGlobal("chrome", {
    runtime: {
      onMessage: {
        addListener: vi.fn(),
      },
    },
  });
});

beforeEach(() => {
  getBoundingClientRectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return syntheticRectFor(this);
  });
  getClientRectsSpy = vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
    const rect = syntheticRectFor(this);
    return (rect.width >= 1 && rect.height >= 1 ? [rect] : []) as unknown as DOMRectList;
  });
});

afterEach(() => {
  getBoundingClientRectSpy.mockRestore();
  getClientRectsSpy.mockRestore();
});

describe("deterministic autofill content script", () => {
  it("opens a review response that matches the background popup contract", async () => {
    const { showAutofillReview } = await import("./content-script");
    document.body.innerHTML = `<label>Email <input name="email" /></label>`;

    const response = showAutofillReview(
      { ok: true, profileVersion: 1, fields: profileFields() },
      document,
      "https://jobs.ashbyhq.com/acme/senior-platform-engineer",
    );

    expect(response).toEqual({
      ok: true,
      status: "review_opened",
      suggestions: 1,
      missing: 0,
    });
    expect(document.getElementById("jobhunter-autofill-root")).not.toBeNull();
  });

  it("rejects unsupported ATS pages before suggesting fields", async () => {
    const { showAutofillReview } = await import("./content-script");
    document.body.innerHTML = `<label>Email <input name="email" /></label>`;

    const response = showAutofillReview(
      { ok: true, profileVersion: 1, fields: profileFields() },
      document,
      "https://example.com/jobs/1",
    );

    expect(response).toMatchObject({ ok: false, error: "unsupported_ats" });
  });

  it("does not expose unaccepted profile values into the page DOM", async () => {
    const { showAutofillReview } = await import("./content-script");
    document.body.innerHTML = `
      <form id="application">
        <label>Your name <input name="candidate_name" /></label>
        <label>Email <input name="email" /></label>
        <label>LinkedIn <input name="linkedin" /></label>
      </form>
    `;

    const response = showAutofillReview(
      { ok: true, profileVersion: 1, fields: profileFields() },
      document,
      "https://jobs.ashbyhq.com/acme/senior-platform-engineer",
    );

    const pageText = document.body.textContent ?? "";
    const inputValues = Array.from(document.querySelectorAll("input"))
      .map((input) => input.value)
      .join("\n");
    expect(response).toMatchObject({ ok: true, status: "review_opened" });
    expect(pageText).toContain("Profile value ready");
    expect(pageText).not.toContain("Jordan Candidate");
    expect(pageText).not.toContain("jordan@example.com");
    expect(pageText).not.toContain("https://linkedin.com/in/jordan");
    expect(inputValues).not.toContain("Jordan Candidate");
    expect(inputValues).not.toContain("jordan@example.com");
    expect(inputValues).not.toContain("https://linkedin.com/in/jordan");
  });

  it("ignores scripted fill clicks from the page before user acceptance", async () => {
    const { showAutofillReview } = await import("./content-script");
    document.body.innerHTML = `
      <form id="application">
        <label>First name <input name="first_name" /></label>
        <label>Last name <input name="last_name" /></label>
        <label>Email <input name="email" /></label>
      </form>
    `;

    showAutofillReview(
      { ok: true, profileVersion: 1, fields: profileFields() },
      document,
      "https://jobs.ashbyhq.com/acme/senior-platform-engineer",
    );
    const fill = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Fill selected");
    fill?.click();

    expect((document.querySelector("[name='first_name']") as HTMLInputElement).value).toBe("");
    expect((document.querySelector("[name='last_name']") as HTMLInputElement).value).toBe("");
    expect((document.querySelector("[name='email']") as HTMLInputElement).value).toBe("");
  });

  it("fills accepted profile-backed fields without submitting the form", async () => {
    const { applyAcceptedSuggestions, buildAutofillSuggestions, collectFieldTargets } = await import("./content-script");
    document.body.innerHTML = `
      <form id="application">
        <label>First name <input name="first_name" /></label>
        <label>Last name <input name="last_name" /></label>
        <label>Email <input name="email" /></label>
        <label>LinkedIn <input name="linkedin" /></label>
        <button type="submit">Submit application</button>
      </form>
    `;
    let submitCount = 0;
    document.getElementById("application")?.addEventListener("submit", () => {
      submitCount += 1;
    });

    const suggestions = buildAutofillSuggestions(profileFields(), collectFieldTargets(document));
    const filled = applyAcceptedSuggestions(suggestions);

    expect(filled).toBe(4);
    expect((document.querySelector("[name='first_name']") as HTMLInputElement).value).toBe("Jordan");
    expect((document.querySelector("[name='last_name']") as HTMLInputElement).value).toBe("Candidate");
    expect((document.querySelector("[name='email']") as HTMLInputElement).value).toBe("jordan@example.com");
    expect((document.querySelector("[name='linkedin']") as HTMLInputElement).value).toBe("https://linkedin.com/in/jordan");
    expect(submitCount).toBe(0);
  });

  it("does not suggest or fill CSS-hidden controls", async () => {
    const { applyAcceptedSuggestions, buildAutofillSuggestions, collectFieldTargets } = await import("./content-script");
    document.body.innerHTML = `
      <form id="application">
        <label>Email <input name="hidden_email_display" style="display: none" /></label>
        <label style="display: none">First name <input name="hidden_first_name_ancestor" /></label>
        <label>LinkedIn <input name="hidden_linkedin_visibility" style="visibility: hidden" /></label>
        <label>Email <input name="visible_email" /></label>
      </form>
    `;

    const suggestions = buildAutofillSuggestions(profileFields(), collectFieldTargets(document));
    const suggestionNames = suggestions.map((suggestion) => suggestion.target.control.getAttribute("name"));
    const filled = applyAcceptedSuggestions(suggestions);

    expect(suggestionNames).toEqual(["visible_email"]);
    expect(filled).toBe(1);
    expect((document.querySelector("[name='hidden_email_display']") as HTMLInputElement).value).toBe("");
    expect((document.querySelector("[name='hidden_first_name_ancestor']") as HTMLInputElement).value).toBe("");
    expect((document.querySelector("[name='hidden_linkedin_visibility']") as HTMLInputElement).value).toBe("");
    expect((document.querySelector("[name='visible_email']") as HTMLInputElement).value).toBe("jordan@example.com");
  });

  it("does not suggest or fill zero-size, offscreen, or clipped controls", async () => {
    const { applyAcceptedSuggestions, buildAutofillSuggestions, collectFieldTargets } = await import("./content-script");
    document.body.innerHTML = `
      <form id="application">
        <label>Email <input name="zero_size_email" data-rect="zero" /></label>
        <label>Email <input name="offscreen_email" data-rect="offscreen" /></label>
        <label>Email <input name="clipped_email" style="clip-path: inset(50%)" /></label>
        <label>Email <input name="visible_email" /></label>
      </form>
    `;

    const suggestions = buildAutofillSuggestions(profileFields(), collectFieldTargets(document));
    const suggestionNames = suggestions.map((suggestion) => suggestion.target.control.getAttribute("name"));
    const filled = applyAcceptedSuggestions(suggestions);

    expect(suggestionNames).toEqual(["visible_email"]);
    expect(filled).toBe(1);
    expect((document.querySelector("[name='zero_size_email']") as HTMLInputElement).value).toBe("");
    expect((document.querySelector("[name='offscreen_email']") as HTMLInputElement).value).toBe("");
    expect((document.querySelector("[name='clipped_email']") as HTMLInputElement).value).toBe("");
    expect((document.querySelector("[name='visible_email']") as HTMLInputElement).value).toBe("jordan@example.com");
  });

  it("rechecks visibility before filling accepted suggestions", async () => {
    const { applyAcceptedSuggestions, buildAutofillSuggestions, collectFieldTargets } = await import("./content-script");
    document.body.innerHTML = `<label>Email <input name="email" /></label>`;

    const [suggestion] = buildAutofillSuggestions(profileFields(), collectFieldTargets(document));
    const email = document.querySelector("[name='email']") as HTMLInputElement;
    email.style.display = "none";
    const filled = applyAcceptedSuggestions(suggestion ? [suggestion] : []);

    expect(filled).toBe(0);
    expect(email.value).toBe("");
  });

  it("labels recognized fields as missing instead of inventing values", async () => {
    const { buildAutofillSuggestions, collectFieldTargets } = await import("./content-script");
    document.body.innerHTML = `<label>Postal code <input name="zip" /></label>`;

    const [suggestion] = buildAutofillSuggestions(profileFields(), collectFieldTargets(document));

    expect(suggestion).toMatchObject({
      profilePath: "personal.postal_code",
      status: "missing",
      value: "",
    });
  });

  it("does not map unrelated entity-name fields to the candidate full name", async () => {
    const { buildAutofillSuggestions, collectFieldTargets } = await import("./content-script");
    document.body.innerHTML = `<label>Company name <input name="company_name" /></label>`;

    const suggestions = buildAutofillSuggestions(profileFields(), collectFieldTargets(document));

    expect(suggestions).toEqual([]);
  });
});

function profileFields(): ExtensionAutofillProfileField[] {
  return [
    field("personal.full_name", "Profile > Personal information > Full name", "Jordan Candidate"),
    field("personal.email", "Profile > Personal information > Email", "jordan@example.com"),
    field("personal.linkedin_url", "Profile > Personal information > LinkedIn URL", "https://linkedin.com/in/jordan"),
  ];
}

function field(path: string, label: string, value: string): ExtensionAutofillProfileField {
  return {
    path,
    label,
    value,
    source: { kind: "profile", path, label },
  };
}

function syntheticRectFor(element: HTMLElement): DOMRect {
  if (element.dataset.rect === "zero") {
    return makeRect(8, 8, 0, 0);
  }
  if (element.dataset.rect === "offscreen") {
    return makeRect(-10_000, 8, 160, 24);
  }
  return makeRect(8, 8, 160, 24);
}

function makeRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}
