import type { ProfilePreviewRenderer } from "../../src/local-actions.js";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const escapeHtml = (value: unknown): string => String(value ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// Exercise the real preview HTTP route and Plate projection without starting a
// renderer subprocess. Every line comes from the route's current stored profile.
export const e2eProfilePreviewRenderer: ProfilePreviewRenderer = async ({ profile }) => {
  const root = record(profile);
  const resume = record(root["resume"]);
  const personal = record(root["personal"]);
  let lineNumber = 0;
  const line = (tag: string, semanticId: string, text: unknown, className = "resume-line", innerHtml?: string) =>
    `<${tag} class="${className}" data-resume-layout-target="${escapeHtml(semanticId)}" data-resume-line-number="${++lineNumber}">${innerHtml ?? escapeHtml(text)}</${tag}>`;
  const entries = Array.isArray(resume["experience_entries"]) ? resume["experience_entries"] : [];
  const education = Array.isArray(resume["education_entries"]) ? resume["education_entries"] : [];
  const skills = Array.isArray(resume["skill_categories"]) ? resume["skill_categories"] : [];
  const address = [
    [personal["address"], personal["city"]].filter(Boolean).join(", "),
    [personal["postal_code"], personal["country"]].filter(Boolean).join(" "),
  ].filter(Boolean).join(" - ");
  const htmlText = `<main class="resume-page" data-resume-page="1">
    <header class="resume-header">${line("h1", "personal:full_name", personal["full_name"], "resume-name")}${address ? line("p", "personal:address", address) : ""}</header>
    <section class="resume-section">${line("p", "summary", record(resume["executive_profile"])["baseline_text"], "resume-summary")}</section>
    <section class="resume-section">${line("h2", "section:experience", "Experience", "resume-section-title")}${entries.map((value) => {
      const entry = record(value);
      const id = String(entry["id"] ?? "");
      const bullets = Array.isArray(entry["bullets"]) ? entry["bullets"] : [];
      const heading = `<span class="resume-entry-row resume-entry-company-row"><span class="resume-entry-company">${escapeHtml(entry["company"])}</span><span class="resume-entry-location">${escapeHtml(entry["location"])}</span></span>
        <span class="resume-entry-row resume-entry-role-row"><span class="resume-entry-title">${escapeHtml(entry["title"])}</span><span class="resume-entry-date">${escapeHtml(entry["date_range"])}</span></span>`;
      return `<article class="resume-entry">${line("div", `experience:${id}:heading`, entry["title"], "resume-entry-heading", heading)}
        ${line("p", `experience:${id}:summary`, entry["summary"], "resume-entry-summary")}
        <ul class="resume-bullets">${bullets.map((text, index) => line("li", `experience:${id}:bullet:${index + 1}`, text)).join("")}</ul></article>`;
    }).join("")}</section>
    <section class="resume-section">${education.map((value) => {
      const entry = record(value);
      const id = String(entry["id"] ?? "");
      const subtitle = [entry["institution"], entry["location"]].filter(Boolean).join(" | ");
      return `<article class="resume-entry compact">${line("div", `education:${id}:subtitle`, subtitle, "resume-entry-heading", `<span class="resume-entry-row resume-entry-education-row"><span class="resume-entry-main resume-entry-institution">${escapeHtml(subtitle)}</span><span class="resume-entry-date">${escapeHtml(entry["date"])}</span></span>`)}
      ${line("p", `education:${id}:degree`, entry["degree"], "resume-entry-title resume-education-degree")}</article>`;
    }).join("")}</section>
    <ul class="resume-skills-list">${skills.map((value) => {
      const category = record(value);
      const items = Array.isArray(category["items"]) ? category["items"] : [];
      return line("li", `skills:${category["id"]}`, "", "resume-line", `<b>${escapeHtml(category["label"])}:</b> ${escapeHtml(items.join(", "))}`);
    }).join("")}</ul></main>`;
  return { htmlText, pdfBytes: Buffer.from("%PDF-1.7\nsynthetic preview fixture") };
};
