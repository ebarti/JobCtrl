import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { ProfileSchema } from "@jobctrl/contracts";
import { sampleProfileResponse, sampleResumeTemplateListResponse } from "../../src/test/fixtures/projections.js";

// Physical pixels from the actual downloaded PDF, independent of DOM boxes and
// the export adapter's own page-slice calculation.
function inkBounds(pgm: Buffer) {
  const header = /^P5\s+(\d+)\s+(\d+)\s+255\s/u.exec(pgm.subarray(0, 100).toString("ascii"));
  if (!header) throw new Error("Expected an 8-bit Poppler grayscale image");
  const width = Number(header[1]);
  const height = Number(header[2]);
  const pixels = pgm.subarray(header[0].length);
  if (pixels.length !== width * height) throw new Error("Incomplete page raster");
  let top = height, bottom = -1, left = width, right = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (pixels[y * width + x]! >= 240) continue;
    top = Math.min(top, y); bottom = Math.max(bottom, y);
    left = Math.min(left, x); right = Math.max(right, x);
  }
  return { width, height, top, bottom, left, right };
}

for (const pageSize of ["a4", "letter"] as const) {
  test(`Plate ${pageSize} export preserves continuation margins and education alignment`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const profile = structuredClone(sampleProfileResponse);
    const profileData = ProfileSchema.parse(profile.profile);
    profileData.resume.education_entries = [{ id: "layout-school", institution: "Example University", location: "Example City", date: "2020", degree: "Example Degree" }];
    profile.profile = profileData;
    const theme = { ...sampleResumeTemplateListResponse.effectiveDefaultVersion.theme, pageSize,
      marginMm: { top: 20, right: 18, bottom: 28, left: 18 } };
    await page.route("**/v1/profile", route => route.fulfill({ json: profile }));
    await page.route("**/v1/resume-templates", route => route.fulfill({ json: {
      ...sampleResumeTemplateListResponse,
      templates: sampleResumeTemplateListResponse.templates.map(template => ({
        ...template, activeVersion: { ...template.activeVersion, theme },
      })),
      effectiveDefaultVersion: { ...sampleResumeTemplateListResponse.effectiveDefaultVersion, theme },
    } }));
    const markers = Array.from({ length: 110 }, (_, index) => `SyntheticLine${String(index + 1).padStart(3, "0")}`);
    const entries = Array.from({ length: 11 }, (_, index) => ({
      company: `SyntheticCompany${index + 1}`, role: `SyntheticRole${index + 1}`,
      lines: markers.slice(index * 10, (index + 1) * 10),
    }));
    const html = `<main class="resume-page"><h1 class="resume-name">Synthetic Layout Candidate</h1>
      <section class="resume-section"><h2 class="resume-section-title">Experience</h2>
      ${entries.map(entry => `<article class="resume-entry"><div class="resume-entry-heading"><span class="resume-entry-row resume-entry-company-row"><span class="resume-entry-company">${entry.company}</span><span class="resume-entry-location">Example City</span></span><span class="resume-entry-row resume-entry-role-row"><span class="resume-entry-title">${entry.role}</span><span class="resume-entry-date">2020</span></span></div><ul class="resume-bullets">${entry.lines.map(marker => `<li>${marker}: Maintained an invented service and documented its operational improvements.</li>`).join("")}</ul></article>`).join("")}
      </section><section class="resume-section"><h2 class="resume-section-title">Education</h2>
      <article class="resume-entry compact"><div class="resume-entry-heading" data-resume-layout-target="education:layout-school:subtitle">
      <span class="resume-entry-row resume-entry-education-row"><span class="resume-entry-main"><span class="resume-entry-institution" data-resume-layout-target="education:layout-school:institution">Example University</span> | <span class="resume-entry-location" data-resume-layout-target="education:layout-school:location">Example City</span></span><span class="resume-entry-date" data-resume-layout-target="education:layout-school:date">2020</span></span></div>
      <p class="resume-entry-title resume-education-degree" data-resume-layout-target="education:layout-school:degree">Example Degree</p></article></section></main>`;
    await page.route("**/v1/profile/preview.html*", route => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto("/profile");
    await page.getByRole("button", { name: "Resume editor", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "Baseline resume editor editor" });
    await expect(editor.getByText("Example University", { exact: true })).toBeVisible();
    const education = await editor.locator(".resume-entry-education-row").evaluate(element => {
      const box = (selector: string) => {
        const target = element.querySelector(selector)!;
        const range = document.createRange(); range.selectNodeContents(target);
        const rect = range.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top };
      };
      return { school: box(".resume-entry-institution"), location: box(".resume-entry-location"), date: box(".resume-entry-date") };
    });
    expect(Math.abs(education.school.top - education.location.top)).toBeLessThan(2);
    expect(education.location.left).toBeGreaterThan(education.school.right);
    expect(education.location.right).toBeLessThan(education.date.left);
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export PDF", exact: true }).click();
    const download = await pending;
    const pdfPath = testInfo.outputPath(`resume-${pageSize}.pdf`);
    await download.saveAs(pdfPath);
    await testInfo.attach(`resume-${pageSize}`, { path: pdfPath, contentType: "application/pdf" });
    const loading = getDocument({ data: new Uint8Array(await readFile(pdfPath)), verbosity: 0 });
    const pdf = await loading.promise;
    const pageCount = pdf.numPages;
    try {
      expect(pdf.numPages).toBeGreaterThan(2);
      const texts: string[] = [];
      for (let number = 1; number <= pdf.numPages; number++) {
        const content = await (await pdf.getPage(number)).getTextContent();
        texts.push(content.items.map(item => "str" in item ? item.str : "").join(" "));
      }
      const text = texts.join(" ");
      for (const marker of markers) expect(text.split(marker)).toHaveLength(2);
      for (const marker of markers) {
        const bulletPage = texts.find(pageText => pageText.includes(marker));
        expect(bulletPage?.replace(/\s+/gu, " ")).toContain(`${marker}: Maintained an invented service and documented its operational improvements.`);
      }
      expect(text).toContain("Example University");
      expect(text).toContain("Example City");
      for (const entry of entries) {
        const entryPage = texts.find(pageText => pageText.includes(`${entry.company} `));
        expect(entryPage).toContain(entry.role);
        expect(entryPage).toContain(entry.lines[0]);
      }
      expect(texts.find(pageText => pageText.includes("Example University"))).toContain("Example Degree");
    } finally { await loading.destroy(); }
    const prefix = testInfo.outputPath("physical-page");
    execFileSync("pdftoppm", ["-r", "72", "-gray", pdfPath, prefix]);
    execFileSync("pdftoppm", ["-r", "96", "-png", pdfPath, prefix]);
    const files = (await readdir(path.dirname(prefix))).filter(file => file.endsWith(".pgm")).sort();
    expect(files).toHaveLength(pageCount);
    const measurements = [];
    for (const file of files) {
      const bounds = inkBounds(await readFile(path.join(path.dirname(prefix), file)));
      measurements.push({ file, ...bounds });
      expect(bounds.width).toBe(pageSize === "a4" ? 596 : 612);
      expect(bounds.height).toBe(pageSize === "a4" ? 842 : 792);
      expect(bounds.bottom).toBeGreaterThan(bounds.top);
      expect(bounds.top).toBeGreaterThanOrEqual(20 * 72 / 25.4 - 2);
      expect(bounds.height - 1 - bounds.bottom).toBeGreaterThanOrEqual(28 * 72 / 25.4 - 2);
      expect(bounds.left).toBeGreaterThanOrEqual(18 * 72 / 25.4 - 2);
      expect(bounds.width - 1 - bounds.right).toBeGreaterThanOrEqual(18 * 72 / 25.4 - 2);
      const png = path.join(path.dirname(prefix), file.replace(/\.pgm$/u, ".png"));
      await testInfo.attach(file.replace(/\.pgm$/u, ""), { path: png, contentType: "image/png" });
    }
    const measurementPath = testInfo.outputPath("physical-page-bounds.json");
    await writeFile(measurementPath, JSON.stringify(measurements, null, 2));
    await testInfo.attach("physical-page-bounds", { path: measurementPath, contentType: "application/json" });
  });
}
