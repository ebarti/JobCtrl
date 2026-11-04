import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { loadE2eDbPath, QA_PLATFORM_JOB_ID } from "../fixtures/e2e-state.js";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

for (const paper of ["a4", "letter"] as const)
  test(`disabled tailoring keeps an editable complete base copy on ${paper}`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    loadE2eDbPath(); // Refuse any workspace without the owned synthetic capability.
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/settings/models");
    await expect(page).toHaveTitle(/JobCtrl/);
    const tailoring = page.getByRole("checkbox", {
      name: "Tailor resumes",
      exact: true,
    });
    if (!(await tailoring.isChecked())) {
      await tailoring.check();
      await page.getByRole("button", { name: "Save AI policy" }).click();
      await expect(
        page.getByText("AI execution policy saved for newly started work."),
      ).toBeVisible();
    }
    await tailoring.uncheck();
    await page.getByRole("button", { name: "Save AI policy" }).click();
    await expect(
      page.getByText("AI execution policy saved for newly started work."),
    ).toBeVisible();
    await page.reload();
    await expect(tailoring).not.toBeChecked();
    await page.screenshot({
      path: testInfo.outputPath("settings-tailoring-disabled.png"),
      fullPage: true,
    });
    const headers = { Origin: new URL(page.url()).origin };
    const initialProfile = await (await page.request.get("/v1/profile")).json();
    const authored = structuredClone(initialProfile.profile);
    const markers = Array.from(
      { length: 40 },
      (_, index) => `BaseCopySource${String(index + 1).padStart(3, "0")}`,
    );
    authored.resume.experience_entries[0].bullets = markers.map(
      (marker) =>
        `${marker}: Maintained an invented service, documented its operations, and kept the authored accomplishment available for independent job editing.`,
    );
    authored.resume.tailoring_rules.max_experience_bullets = 1;
    authored.resume.tailoring_rules.required_bullets_by_experience_id = {};
    const profileSave = await page.request.patch("/v1/profile", {
      headers,
      data: {
        profile: authored,
        expectedProfileVersion: initialProfile.profileVersion,
      },
    });
    expect(profileSave.ok(), await profileSave.text()).toBe(true);
    const profileBefore = await (await page.request.get("/v1/profile")).json();
    const templates = await (
      await page.request.get("/v1/resume-templates")
    ).json();
    const templateSave = await page.request.post("/v1/resume-templates", {
      headers,
      data: {
        displayName: `Owned baseline ${paper}`,
        theme: { ...templates.effectiveDefaultVersion.theme, pageSize: paper },
        layout: {},
      },
    });
    expect(templateSave.ok(), await templateSave.text()).toBe(true);
    const template = (await templateSave.json()).template;
    const assigned = await page.request.patch(
      `/v1/jobs/${QA_PLATFORM_JOB_ID}/resume-template`,
      {
        headers,
        data: {
          templateId: template.templateId,
          versionId: template.activeVersion.versionId,
        },
      },
    );
    expect(assigned.ok(), await assigned.text()).toBe(true);

    const result = JSON.parse(
      execFileSync(
        path.join(root, "workers/automation/.venv/bin/python"),
        [
          path.join(root, "apps/web/e2e/fixtures/prepare-baseline-resume.py"),
          QA_PLATFORM_JOB_ID,
        ],
        {
          cwd: path.join(root, "workers/automation"),
          encoding: "utf8",
          env: {
            PATH: process.env["PATH"],
            PYTHONPATH: path.join(root, "workers/automation"),
            HOME: process.env["JOBCTRL_E2E_SERVICE_HOME"],
            USERPROFILE: process.env["JOBCTRL_E2E_SERVICE_HOME"],
            JOBCTRL_DIR: process.env["JOBCTRL_E2E_APP_DIR"],
            JOBCTRL_DB_PATH: process.env["JOBCTRL_E2E_DB_PATH"],
            JOBCTRL_CONFIG_PATH: process.env["JOBCTRL_E2E_CONFIG_PATH"],
            PLAYWRIGHT_BROWSERS_PATH:
              process.env["PLAYWRIGHT_BROWSERS_PATH"] ??
              path.join(
                os.homedir(),
                process.platform === "darwin"
                  ? "Library/Caches/ms-playwright"
                  : ".cache/ms-playwright",
              ),
            LANGFUSE_DISABLE: "1",
          },
        },
      ),
    ) as {
      pdfArtifactId: string;
      textArtifactId: string;
      pdfPath: string;
      textPath: string;
      scoreUnchanged: boolean;
      origin: { profile_version: number };
    };
    expect(result.scoreUnchanged).toBe(true);
    const artifact = await (
      await page.request.get(`/v1/artifacts/${result.textArtifactId}`)
    ).json();
    expect(artifact.artifact.resumePreparation).toMatchObject({
      mode: "baseline_copy",
      modified: false,
      profileVersion: result.origin.profile_version,
    });
    expect(artifact.tailoringExplanation).toBeNull();
    expect(artifact.determinations).toEqual([]);
    expect(artifact.baselineProvenance.length).toBeGreaterThan(0);
    const accepted = await page.request.get(
      `/v1/artifacts/${result.pdfArtifactId}/preview.pdf`,
    );
    expect(accepted.ok()).toBe(true);
    const pdfBytes = await accepted.body();
    fs.writeFileSync(testInfo.outputPath("accepted-base-copy.pdf"), pdfBytes);
    const loading = getDocument({
      data: new Uint8Array(pdfBytes),
      disableFontFace: true,
      useSystemFonts: false,
    });
    const pdf = await loading.promise;
    expect(pdf.numPages).toBeGreaterThan(1);
    const dimensions = (await pdf.getPage(1)).getViewport({ scale: 1 });
    expect(dimensions.width).toBeCloseTo(paper === "a4" ? 595.28 : 612, 0);
    expect(dimensions.height).toBeCloseTo(paper === "a4" ? 841.89 : 792, 0);
    const text: string[] = [];
    for (let index = 1; index <= pdf.numPages; index++) {
      const content = await (await pdf.getPage(index)).getTextContent();
      text.push(
        content.items.map((item) => ("str" in item ? item.str : "")).join(" "),
      );
    }
    expect(text.join(" ")).toContain(profileBefore.profile.personal.full_name);
    expect(text[0]).toContain(markers[0]);
    for (const marker of markers) expect(text.join(" ")).toContain(marker);
    fs.writeFileSync(
      testInfo.outputPath("pdf-proof.json"),
      JSON.stringify({
        paper,
        pages: pdf.numPages,
        width: dimensions.width,
        height: dimensions.height,
        authoredMarkers: markers.length,
        sourceProfileVersion: result.origin.profile_version,
      }),
    );
    await loading.destroy();

    await page.goto(`/apply-review?jobKey=${QA_PLATFORM_JOB_ID}`);
    const editor = page.getByRole("textbox", {
      name: "Resume editor",
      exact: true,
    });
    await expect(editor).toBeVisible({ timeout: 30_000 });
    await expect(editor).toContainText(
      profileBefore.profile.personal.full_name,
    );
    await expect(
      page.getByRole("region", { name: "Base profile copy" }),
    ).toBeVisible();
    await editor.click();
    await editor.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
    await editor.press("Enter");
    await editor.pressSequentially("Owned job-only note.");
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect(page.locator(".resume-plate-draft-status")).toContainText(
      /saved/i,
    );
    await page.reload();
    await expect(editor).toContainText("Owned job-only note.");
    await expect(editor.locator(".resume-name [data-slate-string]")).toHaveText(profileBefore.profile.personal.full_name);
    expect(await (await page.request.get("/v1/profile")).json()).toEqual(
      profileBefore,
    );
    fs.writeFileSync(testInfo.outputPath("editor-layout.json"), JSON.stringify(await editor.evaluate(element => ({
      document: element.getBoundingClientRect().toJSON(),
      blocks: Array.from(element.querySelectorAll(".resume-section-title, .resume-entry-heading, .resume-bullets > li")).map(node => ({
        kind: node.className, text: node.textContent?.slice(0, 80), rect: node.getBoundingClientRect().toJSON(),
      })),
    }))));
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export PDF", exact: true }).click();
    const editedPdfPath = testInfo.outputPath("edited-job-copy.pdf");
    await (await download).saveAs(editedPdfPath);
    const editedLoading = getDocument({ data: new Uint8Array(fs.readFileSync(editedPdfPath)) });
    const editedPdf = await editedLoading.promise;
    expect(editedPdf.numPages).toBeGreaterThan(1);
    const editedDimensions = (await editedPdf.getPage(1)).getViewport({ scale: 1 });
    expect(editedDimensions.width).toBeCloseTo(dimensions.width, 0);
    expect(editedDimensions.height).toBeCloseTo(dimensions.height, 0);
    const editedText: string[] = [];
    for (let index = 1; index <= editedPdf.numPages; index++) {
      const content = await (await editedPdf.getPage(index)).getTextContent();
      editedText.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
    }
    for (const marker of markers) expect(editedText.join(" ")).toContain(marker);
    expect(editedText[0]).toContain(markers[0]);
    expect(editedText.join("").replace(/\s/g, "")).toContain("Ownedjob-onlynote.");
    await editedLoading.destroy();
    await page.screenshot({
      path: testInfo.outputPath("job-base-copy-editor.png"),
      fullPage: false,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("region", { name: "Base profile copy" }).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath("job-base-copy-mobile.png"),
      fullPage: false,
    });
    expect(errors).toEqual([]);
  });
