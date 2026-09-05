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
  let lineNumber = 0;
  const line = (tag: string, semanticId: string, text: unknown, className = "resume-line", innerHtml?: string) =>
    `<${tag} class="${className}" data-resume-layout-target="${escapeHtml(semanticId)}" data-resume-line-number="${++lineNumber}">${innerHtml ?? escapeHtml(text)}</${tag}>`;
  const entries = Array.isArray(resume["experience_entries"]) ? resume["experience_entries"] : [];
  const htmlText = `<main class="resume-page" data-resume-page="1">
    <header class="resume-header">${line("h1", "personal:full_name", record(root["personal"])["full_name"], "resume-name")}</header>
    <section class="resume-section">${line("p", "summary", record(resume["executive_profile"])["baseline_text"], "resume-summary")}</section>
    <section class="resume-section">${line("h2", "section:experience", "Experience", "resume-section-title")}${entries.map((value) => {
      const entry = record(value);
      const id = String(entry["id"] ?? "");
      const bullets = Array.isArray(entry["bullets"]) ? entry["bullets"] : [];
      const heading = `<span class="resume-entry-row resume-entry-company-row"><span class="resume-entry-company">${escapeHtml(entry["company"])}</span></span>
        <span class="resume-entry-row resume-entry-role-row"><span class="resume-entry-title">${escapeHtml(entry["title"])}</span><span class="resume-entry-date">${escapeHtml(entry["date_range"])}</span></span>`;
      return `<article class="resume-entry">${line("div", `experience:${id}:heading`, entry["title"], "resume-entry-heading", heading)}
        ${line("p", `experience:${id}:summary`, entry["summary"], "resume-entry-summary")}
        <ul class="resume-bullets">${bullets.map((text, index) => line("li", `experience:${id}:bullet:${index + 1}`, text)).join("")}</ul></article>`;
    }).join("")}</section></main>`;
  return { htmlText, pdfBytes: Buffer.from("%PDF-1.7\nsynthetic preview fixture") };
};
