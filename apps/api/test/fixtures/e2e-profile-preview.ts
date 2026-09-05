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
  const line = (tag: string, semanticId: string, text: unknown, className = "") =>
    `<${tag} class="${className}" data-resume-layout-target="${escapeHtml(semanticId)}" data-resume-line-number="${++lineNumber}">${escapeHtml(text)}</${tag}>`;
  const entries = Array.isArray(resume["experience_entries"]) ? resume["experience_entries"] : [];
  const htmlText = `<main class="resume-page" data-resume-page="1">
    <header class="resume-header">${line("h1", "personal:full_name", record(root["personal"])["full_name"], "resume-name")}</header>
    ${line("p", "summary", record(resume["executive_profile"])["baseline_text"])}
    <section>${line("h2", "section:experience", "Experience")}${entries.map((value) => {
      const entry = record(value);
      const id = String(entry["id"] ?? "");
      const bullets = Array.isArray(entry["bullets"]) ? entry["bullets"] : [];
      return `<article>${line("h3", `experience:${id}:position`, entry["title"])}
        ${line("p", `experience:${id}:summary`, entry["summary"])}
        <ul>${bullets.map((text, index) => line("li", `experience:${id}:bullet:${index + 1}`, text)).join("")}</ul></article>`;
    }).join("")}</section></main>`;
  return { htmlText, pdfBytes: Buffer.from("%PDF-1.7\nsynthetic preview fixture") };
};
