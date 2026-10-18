import { test, expect } from "@playwright/test";
import { MaterialLocaleHistorySchema } from "@jobctrl/contracts";
import { openDatabase } from "../../../api/src/db.js";
import { rebuildTenantDeleteProjections } from "../../../api/src/projections.js";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { injectAxe, checkA11y } from "axe-playwright";
import { loadE2eDbPath } from "../fixtures/e2e-state.js";

const root = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const job = "90000000-0000-4000-8000-000000000021";
const secondJob = "90000000-0000-4000-8000-000000000022";
const companyId = createHash("sha256").update("https://example.com/").digest("hex");
let ownsFixture = false;

test.beforeAll(() => {
  // Resolve the independently owned workspace before claiming fixture identities.
  const dbPath = loadE2eDbPath();
  const db = openDatabase(dbPath);
  try {
    expect(db.prepare("SELECT job_id FROM jobs WHERE tenant_id='local' AND job_id IN (?,?)").all(job, secondJob)).toEqual([]);
    expect(db.prepare("SELECT event_id FROM job_events WHERE tenant_id='local' AND entity_ref=?").all(companyId)).toEqual([]);
    expect(db.prepare("SELECT determination_id FROM semantic_determinations WHERE tenant_id='local' AND entity_id=? AND kind='company_briefing'").all(companyId)).toEqual([]);
  } finally { db.close(); }
  ownsFixture = true;
  const result = spawnSync(path.join(root, "workers/automation/.venv/bin/python"), [path.join(root, "workers/automation/tests/company_briefing_fixture.py"), dbPath], {
    cwd: root, encoding: "utf8", env: { ...process.env, JOBCTRL_DIR: process.env["JOBCTRL_E2E_APP_DIR"]!, LANGFUSE_DISABLE: "1", PYTHONPATH: path.join(root, "workers/automation/src") },
  });
  expect(result.status, result.stderr).toBe(0);
});

test.afterAll(() => {
  if (!ownsFixture) return;
  const db = openDatabase(loadE2eDbPath());
  try {
    // Keep the shared suite's jobs and recent activity unchanged, including after
    // a failed test or retry. These identities were absent before this fixture.
    db.transaction(() => {
      db.prepare("DELETE FROM semantic_entity_bindings WHERE tenant_id='local' AND entity_id=? AND determination_kind='company_briefing'").run(companyId);
      db.prepare("DELETE FROM semantic_stage_states WHERE tenant_id='local' AND entity_id=? AND kind='company_briefing'").run(companyId);
      db.prepare("DELETE FROM semantic_determinations WHERE tenant_id='local' AND entity_id=? AND kind='company_briefing'").run(companyId);
      db.prepare("DELETE FROM job_events WHERE tenant_id='local' AND (job_id IN (?,?) OR (entity_ref=? AND entity_kind IN ('company_briefing_config','company_briefing_accepted','company_briefing_attempt','company_briefing_notification')))").run(job, secondJob, companyId);
      // Job projections intentionally have no foreign keys; match the
      // permanent-delete owner's explicit cleanup before rebuilding totals.
      for (const table of ["apply_run_projections", "artifact_list_projections", "job_detail_projections", "job_list_projections"]) {
        db.prepare(`DELETE FROM ${table} WHERE tenant_id='local' AND job_id IN (?,?)`).run(job, secondJob);
      }
      db.prepare("DELETE FROM jobs WHERE tenant_id='local' AND job_id IN (?,?)").run(job, secondJob);
      rebuildTenantDeleteProjections(db, "local");
    })();
  } finally { db.close(); ownsFixture = false; }
});

test.beforeEach(async ({ page }) => {
  if (process.env["JOBCTRL_E2E_ISOLATED"] !== "1") return;
  // The isolated API deliberately denies worker RPC outside its fixtures. This
  // job has no locale artifacts; fixture only that unrelated read dependency.
  // Company briefing, interview and digest reads still use the actual API/DB.
  await page.route(`**/v1/jobs/${job}/material-locales`, async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON().operation).toBe("history");
    await route.fulfill({ json: MaterialLocaleHistorySchema.parse({
      supportedLocales: [], variants: [], profileVersion: null, sources: [],
    }) });
  });
});

for (const mobile of [false, true]) {
  test(`Shared company briefing preserves stale citations across Job Detail, Interviews and digest${mobile ? " @mobile" : ""}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) errors.push(message.text());
    });
    await page.goto(`/jobs/${job}`);
    await expect(page).toHaveURL((url) => url.pathname === `/jobs/${job}`);
    await expect(page).toHaveTitle(/JobCtrl/);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    const briefing = page.getByRole("region", { name: "Company briefing", exact: true });
    await expect(briefing).toBeVisible();
    await expect(briefing).toContainText("Stale briefing");
    await expect(briefing).toContainText("Synthetic company hypothesis");
    await briefing.getByText("Sources for this claim").click();
    await expect(briefing.getByText("Example Company public source text.")).toBeVisible();
    await expect(briefing.getByRole("link", { name: "https://example.com/about" })).toHaveAttribute("href", "https://example.com/about");
    await expect(briefing).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await injectAxe(page);
    await checkA11y(page, '[aria-label="Company briefing"]', { includedImpacts: ["critical", "serious"] });
    await page.screenshot({ path: `/tmp/jobctrl-1016-${mobile ? "mobile" : "desktop"}.png`, fullPage: false });
    await page.goto(`/interviews?card=B11&job=${job}`);
    await expect(page.getByRole("region", { name: "Company briefing", exact: true })).toContainText("Synthetic company hypothesis");
    await page.goto("/");
    await expect(page.getByRole("region", { name: "Company briefings", exact: true })).toContainText("Example Company");
    await expect(page.getByRole("region", { name: "Company briefings", exact: true })).toContainText("stale");
    expect(errors).toEqual([]);
  });
}
