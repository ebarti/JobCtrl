import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { expect, test, type Page } from "@playwright/test";
import { injectAxe, checkA11y } from "axe-playwright";
import { loadE2eDbPath } from "../fixtures/e2e-state.js";

// This spec belongs to the real API/Python RPC CI step. It never stubs exports.
test.skip(
  process.env["JOBCTRL_E2E_ISOLATED"] === "1",
  "Runs in the separate production API/RPC browser gate",
);
const JOB = "90000000-0000-4000-8000-000000001030";
const text = "Zoë Example\nAccepted 25% improvement · €1.2M\t2020–2024\n";

function seed() {
  const dbPath = loadE2eDbPath();
  const root = path.dirname(dbPath);
  const db = new Database(dbPath);
  db.prepare(
    "INSERT INTO jobs(tenant_id,job_id,url,title,company,apply_status) VALUES('local',?,'https://example.test/docx-qa','DOCX export QA','Synthetic Employer','applied')",
  ).run(JOB);
  db.prepare(
    "INSERT INTO job_materials(tenant_id,job_id,generation,status,created_at,updated_at) VALUES('local',?,1,'approved','2026-10-17','2026-10-17')",
  ).run(JOB);
  db.prepare(
    "INSERT INTO application_review_decisions(tenant_id,decision_id,job_id,decision,decided_at,materials_generation) VALUES('local','docx-qa-review',?,'approved','2026-10-17',1)",
  ).run(JOB);
  for (const kind of ["tailored_resume", "cover_letter"]) {
    const filename = path.join(root, `docx-qa-${kind}.txt`);
    fs.writeFileSync(filename, text);
    db.prepare(
      "INSERT INTO job_materials_artifacts(tenant_id,job_id,generation,artifact_type,artifact_id,status,path,render_format,created_at,metadata_json) VALUES('local',?,1,?,?,'approved',?,'text','2026-10-17',?)",
    ).run(
      JOB,
      kind,
      `docx-qa-${kind}`,
      filename,
      JSON.stringify(kind === "tailored_resume" ? { locale: "fr-FR" } : {}),
    );
  }
  const preserved = () =>
    JSON.stringify(
      [
        "jobs",
        "job_materials",
        "job_materials_artifacts",
        "application_review_decisions",
      ].map((table) =>
        db
          .prepare(
            `SELECT * FROM ${table} WHERE tenant_id='local' AND job_id=?`,
          )
          .all(JOB),
      ),
    );
  return { db, root, preserved };
}

async function openPanel(page: Page) {
  await page.goto(`/jobs/${JOB}`);
  await expect(page).toHaveURL(new RegExp(`/jobs/${JOB}`));
  await expect(page).toHaveTitle(/JobCtrl/);
  const panel = page.getByRole("region", { name: "Editable DOCX exports" });
  await panel.scrollIntoViewIfNeeded();
  await expect(
    panel.getByRole("button", { name: "Export resume DOCX" }),
  ).toBeEnabled();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  return panel;
}

test("accepted DOCX exports round-trip through the browser, API, Python worker and download", async ({
  page,
}, testInfo) => {
  const env = seed();
  const before = env.preserved();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      ["error", "warning"].includes(message.type()) &&
      !message.text().includes("Failed to load resource")
    )
      errors.push(message.text());
  });
  try {
    const panel = await openPanel(page);
    for (const paper of ["A4", "Letter"])
      for (const kind of ["resume", "cover letter"]) {
        await panel.getByRole("button", { name: paper, exact: true }).click();
        const downloadPromise = page.waitForEvent("download");
        await panel
          .getByRole("button", { name: `Export ${kind} DOCX` })
          .click();
        const download = await downloadPromise;
        expect(download.suggestedFilename()).toBe(
          `${kind.replace(" ", "-")}-g1-${paper}.docx`,
        );
        const saved = testInfo.outputPath(download.suggestedFilename());
        await download.saveAs(saved);
        const python = path.resolve(
          process.cwd(),
          "../../workers/automation/.venv/bin/python",
        );
        const read = spawnSync(
          python,
          [
            "-c",
            "import json,sys; from docx import Document; d=Document(sys.argv[1]); print(json.dumps({'text':'\\n'.join(p.text for p in d.paragraphs),'width':round(d.sections[0].page_width.inches,2),'locale':d.core_properties.language}))",
            saved,
          ],
          { encoding: "utf8" },
        );
        expect(read.status, read.stderr).toBe(0);
        expect(JSON.parse(read.stdout)).toEqual({
          text,
          width: paper === "A4" ? 8.27 : 8.5,
          locale: kind === "resume" ? "fr-FR" : "und",
        });
        await expect(panel.getByRole("status")).toHaveText(
          "Download started. A retained copy remains available below.",
        );
      }
    await expect(
      panel.getByRole("button", { name: "Download DOCX", exact: true }),
    ).toHaveCount(4);
    await panel.getByText("Export details and limitations").first().click();
    await expect(
      panel
        .getByRole("article")
        .first()
        .getByText(/Source language was not recorded/),
    ).toBeVisible();
    // Fit the retained list in the capture without resizing across a sticky header.
    await page.setViewportSize({ width: 1280, height: 1400 });
    await panel.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await panel.screenshot({ path: testInfo.outputPath("docx-desktop.png") });
    await injectAxe(page);
    await checkA11y(page, 'section[aria-label="Editable DOCX exports"]', {
      includedImpacts: ["critical", "serious"],
    });

    const retained = env.db
      .prepare(
        "SELECT artifact_id,path FROM job_artifacts WHERE job_id=? AND artifact_type='material_docx' ORDER BY artifact_id DESC",
      )
      .all(JOB) as { artifact_id: number; path: string }[];
    const latest = retained[0]!;
    const bytes = fs.readFileSync(latest.path);
    fs.unlinkSync(latest.path);
    await panel
      .getByRole("button", { name: "Download DOCX", exact: true })
      .first()
      .click();
    await expect(
      panel.getByText("Download failed", { exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Download DOCX", exact: true }),
    ).toHaveCount(4);
    fs.writeFileSync(latest.path, bytes);
    const retry = page.waitForEvent("download");
    await panel
      .getByRole("button", { name: "Download DOCX", exact: true })
      .first()
      .click();
    expect(await (await retry).failure()).toBeNull();

    const sourcePath = path.join(env.root, "docx-qa-tailored_resume.txt");
    // Race a real source edit after the UI has bound its export request.
    await page.route(`**/v1/jobs/${JOB}/material-exports`, async (route) => {
      if (route.request().postDataJSON().operation === "export")
        fs.writeFileSync(sourcePath, "Concurrent accepted edit");
      await route.continue();
    });
    await panel.getByRole("button", { name: "Export resume DOCX" }).click();
    await expect(
      panel.getByText("DOCX export failed", { exact: true }),
    ).toBeVisible();
    await expect(panel.getByText(/The accepted source changed/)).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Download DOCX", exact: true }),
    ).toHaveCount(4);
    await panel.screenshot({
      path: testInfo.outputPath("docx-stale-source.png"),
    });
    fs.writeFileSync(sourcePath, text);
    expect(
      env.db
        .prepare(
          "SELECT COUNT(*) AS count FROM job_artifacts WHERE job_id=? AND artifact_type='material_docx'",
        )
        .get(JOB),
    ).toEqual({ count: 4 });
    expect(env.preserved()).toBe(before);
    expect(errors).toEqual([]);
  } finally {
    env.db
      .prepare("DELETE FROM jobs WHERE job_id=? AND tenant_id='local'")
      .run(JOB);
    env.db.close();
  }
});

test("@mobile accepted DOCX controls fit the viewport and download the selected letter", async ({
  page,
}, testInfo) => {
  const env = seed();
  try {
    const panel = await openPanel(page);
    await panel.getByRole("button", { name: "Letter", exact: true }).click();
    const pending = page.waitForEvent("download");
    await panel
      .getByRole("button", { name: "Export cover letter DOCX" })
      .click();
    expect((await pending).suggestedFilename()).toBe(
      "cover-letter-g1-Letter.docx",
    );
    await expect(
      panel.getByRole("button", { name: "Download DOCX", exact: true }),
    ).toBeEnabled();
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath("docx-mobile.png"),
      fullPage: false,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await injectAxe(page);
    await checkA11y(page, 'section[aria-label="Editable DOCX exports"]', {
      includedImpacts: ["critical", "serious"],
    });
  } finally {
    env.db
      .prepare("DELETE FROM jobs WHERE job_id=? AND tenant_id='local'")
      .run(JOB);
    env.db.close();
  }
});
