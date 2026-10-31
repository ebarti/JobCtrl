import Database from "better-sqlite3";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { loadE2eDbPath, QA_PLATFORM_JOB_ID } from "../fixtures/e2e-state.js";
import { recordOutcomeDecision } from "../../../api/test/semantic-fixtures.js";

test.setTimeout(90_000);

async function switchTheme(page: Page, info: TestInfo, next: "light" | "dark"): Promise<void> {
  if (info.project.name === "mobile-chromium") {
    await page.getByRole("button", { name: "Open display preferences" }).click();
    await page.getByRole("menuitem", { name: new RegExp(`Use ${next} theme`, "i") }).click();
  } else {
    await page.getByRole("button", { name: new RegExp(`Switch to ${next} theme`, "i") }).click();
  }
  await expect(page.locator("html")).toHaveAttribute("data-theme", next);
}

async function exerciseConflict(page: Page, info: TestInfo): Promise<void> {
  const suffix = info.project.name;
  const suggestionId = `outcome-conflict-${suffix}`;
  const evidenceId = `outcome-evidence-${suffix}`;
  const messageId = `outcome-message-${suffix}`;
  const quote = "Please choose a time for the interview.";
  const db = new Database(loadE2eDbPath());
  try {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO application_email_evidence
      (tenant_id,evidence_id,job_id,provider,provider_message_id,linked_at,link_confidence,link_signals_json,body_text)
      VALUES ('local',?,?,'gmail',?,?,0.9,'[]',?)`).run(evidenceId, QA_PLATFORM_JOB_ID, messageId, now, quote);
    db.prepare(`INSERT INTO application_outcome_suggestions
      (tenant_id,suggestion_id,job_id,evidence_id,suggested_kind,confidence,rationale,status,created_at)
      VALUES ('local',?,?,?,'interview',0.9,'Synthetic review','pending',?)`).run(suggestionId, QA_PLATFORM_JOB_ID, evidenceId, now);
    recordOutcomeDecision(db, suggestionId, messageId, "interview", 0.9, quote);
  } finally { db.close(); }

  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/jobs/${QA_PLATFORM_JOB_ID}`);
  if (info.project.name === "mobile-chromium") {
    await switchTheme(page, info, "dark");
  }
  await page.getByRole("button", { name: "Sections", exact: true }).click();
  await page.getByRole("navigation", { name: "Job detail sections" }).getByRole("button", { name: "Application outcomes", exact: true }).click();
  const card = page.locator(`[aria-labelledby="outcome-suggestion-${suggestionId}-title"]`);
  await expect(card).toBeVisible();
  await card.getByLabel("Reason").fill("My attempted correction");
  await card.getByLabel("Local note").fill("Keep my synthetic draft");
  const earlier = await page.request.post(`/v1/outcome-suggestions/${suggestionId}/decision`, {
    headers: { origin: new URL(page.url()).origin },
    data: { decision: "ignore", reason: "Earlier review" },
  });
  expect(earlier.status(), await earlier.text()).toBe(200);
  await card.getByRole("button", { name: /^correct suggestion/i }).click();
  await expect(card.getByRole("alert")).toContainText("Your requested decision was not applied");
  await expect(card.getByRole("alert")).toContainText("Saved decision: ignored");
  await expect(card.getByRole("alert")).toContainText("Earlier review");
  await expect(card.getByLabel("Reason")).toHaveValue("My attempted correction");
  await expect(card.getByLabel("Local note")).toHaveValue("Keep my synthetic draft");
  await expect(card.getByRole("button", { name: /^correct suggestion/i })).toBeDisabled();
  expect(errors).toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);
  if (process.env["JOBCTRL_QA_SCREENSHOT_DIR"]) {
    const initialTheme = info.project.name === "mobile-chromium" ? "dark" : "light";
    await card.screenshot({ path: `${process.env["JOBCTRL_QA_SCREENSHOT_DIR"]}/outcome-conflict-${suffix}-${initialTheme}.png` });
    await switchTheme(page, info, initialTheme === "light" ? "dark" : "light");
    await expect(card.getByRole("alert")).toContainText("Saved decision: ignored");
    await card.screenshot({ path: `${process.env["JOBCTRL_QA_SCREENSHOT_DIR"]}/outcome-conflict-${suffix}-${initialTheme === "light" ? "dark" : "light"}.png` });
  }
  await card.getByRole("button", { name: "Dismiss" }).click();
  await expect(card).toHaveCount(0);
}

test("preserves a conflicting outcome correction", async ({ page }, info) => exerciseConflict(page, info));
test("@mobile preserves a conflicting outcome correction", async ({ page }, info) => exerciseConflict(page, info));
